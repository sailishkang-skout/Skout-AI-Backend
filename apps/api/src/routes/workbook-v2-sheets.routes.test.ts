import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { invalidateWorkspaceAccess } from "@skout/auth";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { withFailingCellInserts } from "../test/failing-cell-inserts.js";
import { FakeGoogle, type FakeGoogleCall, type FakeTab } from "../test/fake-google.js";
import { importStorage } from "../services/workbook-import-storage.js";
import { runImportJob } from "../services/workbook-import-runner.js";
import { sheetsReader } from "../services/workbook-sheets-access.js";
import { SHEETS_RETRY } from "../services/google-sheets.client.js";

/**
 * WB2-025: Google Sheets as a row source, through the real routes against a real database. Google is the stand-in in
 * `test/fake-google.ts`; Redis is replaced by a recorder, and background jobs are run here by calling what the worker
 * calls.
 */
const queue = vi.hoisted(() => ({ ready: true, jobs: [] as Array<{ importId: string; workspaceId: string }> }));
vi.mock("../workers/workbook-import.queue.js", () => ({
  workbookImportQueue: () => ({
    ready: async () => queue.ready,
    enqueue: async (job: { importId: string; workspaceId: string }) => void queue.jobs.push(job),
  }),
  closeWorkbookImportQueue: async () => {},
}));

const base = loadEnv();
const hasDatabase = Boolean(base.DATABASE_URL);
const URL_BASE = "/api/v1/workbooks-v2";
const MISSING = "00000000-0000-4000-8000-0000000000ff";
const SECRETS = /secret detail|ya29-secret|refresh-secret|code-secret|sheets-client-secret/;
const { workbooks, workbookColumns, workbookRows, workbookCells, workbookRuns, workbookImports, workbookSheetSources, workbookSheetKeys, googleSheetsConnections, entitlements, auditLogs, enrichmentJobs, enrichmentResults, creditBalances, creditTransactions, asyncJobs } = schema;

interface ImportBody {
  id: string;
  sourceType: string;
  sourceName: string | null;
  sheet: { sourceId: string | null; spreadsheetName: string; tabName: string; pull: boolean } | null;
  fileName: string;
  status: string;
  background: boolean;
  progress: number;
  truncated: unknown;
  counts: { total: number; processed: number; imported: number; duplicates: number; skipped: number; failed: number; alreadyImported?: number };
  error: { code: string; message: string } | null;
  report: { available: boolean; rows: number };
  preview: {
    headers: Array<{ index: number; name: string; fits: string[]; filled: number }>;
    rows: Array<{ line: number; values: string[] }>;
    suggestions: Array<{ header: number; target: any }>;
    sheet: { spreadsheetName: string; tabName: string; unique: Array<boolean | null>; source: { id: string; idColumn: number | null; idHeading: string | null; identityColumnIds: string[] } | null };
  } | null;
}

describe.skipIf(!hasDatabase)("Workbooks V2 Google Sheets import", () => {
  const { db, sql } = createDb(base.DATABASE_URL!);
  const suffix = Math.random().toString(36).slice(2, 10);
  const config = {
    ...base,
    CLERK_SECRET_KEY: undefined,
    LOG_LEVEL: "fatal" as const,
    EARLY_ACCESS_GATE_ENABLED: "true" as never,
    RATE_LIMIT_MAX: 100_000,
    PLATFORM_ADMIN_EMAILS: [],
    EXPORTS_BUCKET: undefined,
    FRONTEND_URL: "https://app.example.test",
    GOOGLE_SHEETS_CLIENT_ID: "sheets-client-id",
    GOOGLE_SHEETS_CLIENT_SECRET: "sheets-client-secret",
    GOOGLE_SHEETS_REDIRECT_URI: undefined,
    INTEGRATION_ENCRYPTION_KEY: "test-integration-key-0123456789",
  };
  const google = new FakeGoogle();
  const previousDir = process.env.WORKBOOK_IMPORTS_LOCAL_DIR;
  const retry = { ...SHEETS_RETRY };
  let dir: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let n = 0;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "wb2-sheets-test-"));
    process.env.WORKBOOK_IMPORTS_LOCAL_DIR = dir;
    app = await buildApp(config);
  });
  beforeEach(() => {
    queue.ready = true;
    queue.jobs.length = 0;
    google.reset();
    Object.assign(SHEETS_RETRY, retry, { baseMs: 1, maxMs: 2 });
    vi.stubGlobal("fetch", (input: any, init?: RequestInit) => (google.handles(String(input?.url ?? input)) ? google.fetch(input, init) : realFetch(input, init)));
  });
  afterAll(async () => {
    Object.assign(SHEETS_RETRY, retry);
    vi.unstubAllGlobals();
    await app.close();
    await sql.end();
    if (previousDir === undefined) delete process.env.WORKBOOK_IMPORTS_LOCAL_DIR;
    else process.env.WORKBOOK_IMPORTS_LOCAL_DIR = previousDir;
    await rm(dir, { recursive: true, force: true });
  });

  // ── People, connections and workbooks ──────────────────────────────────────

  interface User {
    userId: string;
    workspaceId: string;
    ip: string;
    /** The Google account this person signs in with. */
    google: string;
    headers: Record<string, string>;
  }

  async function person(): Promise<User> {
    n += 1;
    const email = `wb2-sheets-${suffix}-${n}@test.com`;
    const ip = `20.${Math.floor(n / 250)}.${n % 250}.7`;
    await app.inject({ method: "GET", url: "/api/v1/me", headers: { "x-stub-user-email": email }, remoteAddress: ip });
    const [u] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
    const [m] = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, u!.id));
    await db.update(schema.workspaces).set({ accessStatus: "active" }).where(eq(schema.workspaces.id, m!.workspaceId));
    await setEntitlement(m!.workspaceId, "feature.workbooks_v2", true);
    return { userId: u!.id, workspaceId: m!.workspaceId, ip, google: `g${suffix}${n}`, headers: { "x-stub-user-email": email } };
  }

  async function setEntitlement(workspaceId: string, key: string, value: unknown) {
    await db
      .insert(entitlements)
      .values({ workspaceId, key, value, source: "test" })
      .onConflictDoUpdate({ target: [entitlements.workspaceId, entitlements.key], set: { value } });
    invalidateWorkspaceAccess(workspaceId);
  }

  async function colleague(owner: User, permissions: string[]): Promise<User> {
    const other = await person();
    await db.insert(schema.workspaceMembers).values({ workspaceId: owner.workspaceId, userId: other.userId, role: "member" });
    await db.delete(schema.workspaceMemberRoles).where(and(eq(schema.workspaceMemberRoles.workspaceId, owner.workspaceId), eq(schema.workspaceMemberRoles.userId, other.userId)));
    const key = `sheets-${suffix}-${++n}`;
    const [role] = await db.insert(schema.roles).values({ workspaceId: owner.workspaceId, key, name: key, description: "test", isSystem: false }).returning();
    if (permissions.length) await db.insert(schema.rolePermissions).values(permissions.map((permissionKey) => ({ roleId: role!.id, permissionKey })));
    await db.insert(schema.workspaceMemberRoles).values({ workspaceId: owner.workspaceId, userId: other.userId, roleId: role!.id });
    return { ...other, workspaceId: owner.workspaceId, headers: { ...other.headers, "x-workspace-id": owner.workspaceId } };
  }

  type Method = "GET" | "POST" | "PATCH" | "DELETE";
  const send = (u: User, method: Method, url: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      remoteAddress: u.ip,
      headers: { ...u.headers, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
  const call = (u: User, method: Method, p: string, body?: unknown, headers: Record<string, string> = {}) => send(u, method, `/workbooks-v2${p}`, body, headers);

  const start = async (u: User) => {
    const res = await send(u, "POST", "/google-sheets/connection/start");
    expect(res.statusCode, res.body).toBe(200);
    return new URL(res.json().data.authorizationUrl);
  };
  const complete = (u: User, state: string, code = google.consent(u.google)) => send(u, "POST", "/google-sheets/connection", { code, state });
  async function connect(u: User) {
    const url = await start(u);
    const res = await complete(u, url.searchParams.get("state")!);
    expect(res.statusCode, res.body).toBe(200);
    google.calls = [];
  }
  /** A workspace owner who connected Google Sheets. */
  async function user(): Promise<User> {
    const u = await person();
    await connect(u);
    return u;
  }
  const connectionOf = async (u: User) => (await db.select().from(googleSheetsConnections).where(and(eq(googleSheetsConnections.workspaceId, u.workspaceId), eq(googleSheetsConnections.userId, u.userId))))[0];
  const connectionStatus = async (u: User) => (await send(u, "GET", "/google-sheets/connection")).json().data.status as string;

  async function workbook(u: User, columns: Array<{ name: string; type?: "input" | "enrichment" | "formula" | "ai" | "action"; dataType?: string }> = []) {
    const res = await call(u, "POST", "", { name: "Sheets" });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().data.id as string;
    const made = columns.map((c, position) => ({
      id: randomUUID(),
      workbookId: id,
      name: c.name,
      type: c.type ?? ("input" as const),
      operation: c.type === "enrichment" ? "find_email" : c.type === "action" ? "add_to_list" : null,
      position,
      config: !c.type || c.type === "input" ? { dataType: c.dataType ?? "text" } : { inputs: {} },
    }));
    if (made.length) await db.insert(workbookColumns).values(made);
    return { id, col: Object.fromEntries(made.map((c) => [c.name, c.id])) as Record<string, string> };
  }

  // ── Spreadsheets ───────────────────────────────────────────────────────────

  const HEAD = ["Name", "Email", "LinkedIn", "Domain"];
  const personRow = (i: number) => [`Person ${i}`, `p${i}@company${i}.com`, `https://www.linkedin.com/in/person-${i}`, `company${i}.com`];
  const people = (count: number, first = 1) => Array.from({ length: count }, (_, i) => personRow(first + i));
  /** A spreadsheet the person can open, with one tab. */
  function sheet(u: User, rows: string[][] = people(3), tab: Partial<FakeTab> = {}) {
    n += 1;
    const made = google.add({ id: `sheet-${suffix}-${n}-abcdefghijklmnop`, title: "Pipeline", tabs: [{ sheetId: 0, title: "Leads", values: [HEAD, ...rows], ...tab }] }, u.google);
    return { ...made, link: `https://docs.google.com/spreadsheets/d/${made.id}/edit`, tab: made.tabs[0]!, set: (next: string[][]) => (made.tabs[0]!.values = [made.tabs[0]!.values[0]!, ...next]) };
  }
  type Sheet = ReturnType<typeof sheet>;

  const preview = (u: User, workbookId: string, s: Sheet, sheetId = 0, headers: Record<string, string> = {}) =>
    call(u, "POST", `/${workbookId}/sheets-imports`, { spreadsheet: s.link, sheetId }, headers);
  async function previewed(u: User, workbookId: string, s: Sheet): Promise<ImportBody> {
    const res = await preview(u, workbookId, s);
    expect(res.statusCode, res.body).toBe(201);
    return res.json().data;
  }
  /** The mapping suggested by the preview, as a confirm body. */
  const suggested = (item: ImportBody, extra: Record<string, unknown> = {}) => ({
    columns: item.preview!.suggestions.flatMap((s) => (s.target ? [{ header: s.header, ...s.target }] : [])),
    dedupe: { key: "none" },
    ...extra,
  });
  const confirm = (u: User, workbookId: string, importId: string, body: unknown) => call(u, "POST", `/${workbookId}/imports/${importId}/confirm`, body);
  async function status(u: User, workbookId: string, importId: string): Promise<ImportBody> {
    const res = await call(u, "GET", `/${workbookId}/imports/${importId}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data;
  }
  const storage = () => importStorage(config)!;
  const work = (importId: string, lastAttempt = false) => runImportJob(db, storage(), importId, lastAttempt, undefined, undefined, sheetsReader(db, config));
  /** Preview, accept the suggestions, and run in the background if it has to. */
  async function imported(u: User, workbookId: string, s: Sheet, extra: Record<string, unknown> = {}): Promise<ImportBody> {
    const item = await previewed(u, workbookId, s);
    const res = await confirm(u, workbookId, item.id, suggested(item, extra));
    expect([200, 202], res.body).toContain(res.statusCode);
    if (res.statusCode === 202) await work(item.id);
    return status(u, workbookId, item.id);
  }
  const sources = async (u: User, workbookId: string) => (await call(u, "GET", `/${workbookId}/sheet-sources`)).json().data as Array<{ id: string; tabName: string; idColumn: string | null; rows: number; lastPulledAt: string | null; runningImportId: string | null }>;
  const sourceOf = async (u: User, workbookId: string) => (await sources(u, workbookId))[0]!.id;
  const pull = (u: User, workbookId: string, sourceId: string, headers: Record<string, string> = {}) => call(u, "POST", `/${workbookId}/sheet-sources/${sourceId}/pull`, {}, headers);
  async function pulled(u: User, workbookId: string, sourceId?: string): Promise<ImportBody> {
    const res = await pull(u, workbookId, sourceId ?? (await sourceOf(u, workbookId)));
    expect([200, 202], res.body).toContain(res.statusCode);
    if (res.statusCode === 202) await work(res.json().data.id);
    return status(u, workbookId, res.json().data.id);
  }
  const report = async (u: User, workbookId: string, importId: string) =>
    (await call(u, "GET", `/${workbookId}/imports/${importId}/report`)).body.replace(/^\uFEFF/, "").trimEnd().split("\r\n");

  async function stored(workbookId: string) {
    const columns = await db.select().from(workbookColumns).where(eq(workbookColumns.workbookId, workbookId));
    const name = new Map(columns.map((c) => [c.id, c.name]));
    const rows = await db.select().from(workbookRows).where(eq(workbookRows.workbookId, workbookId)).orderBy(asc(workbookRows.position));
    const cells = await db.select().from(workbookCells).where(eq(workbookCells.workbookId, workbookId));
    const byRow = new Map<number, Record<string, unknown>>();
    for (const c of cells) byRow.set(c.rowId, { ...byRow.get(c.rowId), [name.get(c.columnId)!]: c.value });
    return rows.map((r) => ({ ...r, from: r.source as Record<string, unknown>, values: byRow.get(r.id) ?? {} }));
  }
  const names = async (workbookId: string) => (await stored(workbookId)).map((r) => r.values.Name);
  const rowCount = async (workbookId: string) => (await db.select({ n: workbooks.rowCount }).from(workbooks).where(eq(workbooks.id, workbookId)))[0]!.n;
  const events = (workbookId: string) =>
    db.select().from(auditLogs).where(and(eq(auditLogs.entityId, workbookId), eq(auditLogs.action, "workbook.rows.added"))).orderBy(asc(auditLogs.createdAt));
  const refused = async (res: ReturnType<typeof send>, httpStatus: number, code: string) => {
    const answer = await res;
    expect(answer.statusCode, answer.body).toBe(httpStatus);
    expect(answer.json().code ?? answer.json().error).toBe(code);
    expect(answer.body).not.toMatch(SECRETS);
    return answer.json();
  };
  const range = (from: number) => (c: FakeGoogleCall) => c.range?.includes(`!A${from}:`) === true;

  // ── Connecting ─────────────────────────────────────────────────────────────

  describe("connection", () => {
    it("is not connected to start with, and says when the server has no Google app", async () => {
      const u = await person();
      expect((await send(u, "GET", "/google-sheets/connection")).json().data).toEqual({ configured: true, status: "not_connected", connectedAt: null });
      const bare = await buildApp({ ...config, GOOGLE_SHEETS_CLIENT_ID: undefined });
      const get = await bare.inject({ method: "GET", url: "/api/v1/google-sheets/connection", headers: u.headers, remoteAddress: u.ip });
      expect(get.json().data.configured).toBe(false);
      const begin = await bare.inject({ method: "POST", url: "/api/v1/google-sheets/connection/start", headers: u.headers, remoteAddress: u.ip });
      expect(begin.statusCode).toBe(503);
      await bare.close();
    });

    it("asks Google for read-only spreadsheet access and nothing else", async () => {
      const u = await person();
      const url = await start(u);
      expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        client_id: "sheets-client-id",
        redirect_uri: "https://app.example.test/app/settings/google-sheets",
        response_type: "code",
        scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
        access_type: "offline",
        prompt: "consent",
        state: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      });
      // The state itself is not stored, and neither is anything secret in the address.
      const row = await connectionOf(u);
      expect(row).toMatchObject({ status: "pending", accessTokenEncrypted: null });
      expect(row!.stateHash).not.toContain(url.searchParams.get("state"));
      expect(url.toString()).not.toContain("sheets-client-secret");
      expect(await connectionStatus(u)).toBe("not_connected");
    });

    it("keeps the tokens encrypted, and returns none of them", async () => {
      const u = await person();
      const url = await start(u);
      const res = await complete(u, url.searchParams.get("state")!);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data).toEqual({ configured: true, status: "connected", connectedAt: expect.any(String) });
      expect(res.body).not.toMatch(SECRETS);
      const row = await connectionOf(u);
      expect(JSON.stringify(row)).not.toMatch(SECRETS);
      expect(row!.accessTokenEncrypted!.split(":")).toHaveLength(3);
      expect(row!.refreshTokenEncrypted!.split(":")).toHaveLength(3);
      expect(row).toMatchObject({ stateHash: null, stateExpiresAt: null });
      const exchange = google.calls.find((c) => c.path === "/token")!;
      expect(exchange.url).not.toContain("secret");
      expect(exchange.form).toMatchObject({ grant_type: "authorization_code", redirect_uri: "https://app.example.test/app/settings/google-sheets" });
    });

    it("accepts a state once, and only an unexpired one it issued", async () => {
      const u = await person();
      const state = (await start(u)).searchParams.get("state")!;
      await refused(complete(u, "never-issued"), 400, "invalid_oauth_state");
      expect((await complete(u, state)).statusCode).toBe(200);
      await refused(complete(u, state), 400, "invalid_oauth_state");

      const late = await person();
      const old = (await start(late)).searchParams.get("state")!;
      await db.update(googleSheetsConnections).set({ stateExpiresAt: new Date(Date.now() - 1_000) }).where(eq(googleSheetsConnections.userId, late.userId));
      await refused(complete(late, old), 400, "invalid_oauth_state");
      expect(await connectionStatus(late)).toBe("not_connected");
    });

    it("never finishes one person's sign-in into another's account", async () => {
      const [attacker, victim] = [await person(), await person()];
      const mate = await colleague(attacker, ["enrichment:read", "enrichment:capture"]);
      const state = (await start(attacker)).searchParams.get("state")!;
      // The victim consents at an address the attacker made; their app then reports it as them.
      await refused(complete(victim, state), 400, "invalid_oauth_state");
      await refused(complete(mate, state), 400, "invalid_oauth_state");
      expect(google.calls.filter((c) => c.path === "/token")).toEqual([]);
      expect(await connectionStatus(attacker)).toBe("not_connected");
      expect(await connectionStatus(victim)).toBe("not_connected");
    });

    it.each([
      ["the permission was unticked", () => (google.grantedScope = "openid"), 400, "google_permission_not_granted"],
      ["Google gave no refresh token", () => (google.issueRefreshToken = false), 400, "google_sign_in_failed"],
      ["Google is down", () => google.fail((c) => c.path === "/token", 503), 502, "google_unavailable"],
    ])("does not connect when %s", async (_why, arrange, httpStatus, code) => {
      const u = await person();
      const state = (await start(u)).searchParams.get("state")!;
      arrange();
      await refused(complete(u, state), httpStatus, code);
      expect(await connectionStatus(u)).toBe("not_connected");
    });

    it("withdraws a grant that came without the permission asked for", async () => {
      const u = await person();
      const state = (await start(u)).searchParams.get("state")!;
      google.grantedScope = "openid";
      await complete(u, state);
      expect(google.calls.some((c) => c.path === "/revoke")).toBe(true);
      expect(google.refresh.size).toBe(0);
    });

    it("refuses a bad code and a malformed request", async () => {
      const u = await person();
      const state = (await start(u)).searchParams.get("state")!;
      await refused(complete(u, state, "not-a-code"), 400, "google_sign_in_failed");
      for (const body of [{}, { code: "x" }, { state: "x" }, { code: "x", state: "y", userId: MISSING }]) {
        expect((await send(u, "POST", "/google-sheets/connection", body)).statusCode).toBe(422);
      }
    });

    it("keeps a working connection while a new sign-in is under way", async () => {
      const u = await user();
      await start(u);
      expect(await connectionStatus(u)).toBe("connected");
    });

    it("belongs to one member of one workspace", async () => {
      const owner = await user();
      const mate = await colleague(owner, ["enrichment:read", "enrichment:capture"]);
      expect(await connectionStatus(mate)).toBe("not_connected");
      expect((await send(mate, "DELETE", "/google-sheets/connection")).json().data.disconnected).toBe(false);
      expect(await connectionStatus(owner)).toBe("connected");
    });

    it("renews an expired access token by itself", async () => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u);
      await db.update(googleSheetsConnections).set({ tokenExpiresAt: new Date(Date.now() - 1_000) }).where(eq(googleSheetsConnections.userId, u.userId));
      const before = (await connectionOf(u))!.accessTokenEncrypted;
      await previewed(u, b.id, s);
      expect(google.calls[0]).toMatchObject({ path: "/token", form: { grant_type: "refresh_token" } });
      expect((await connectionOf(u))!.accessTokenEncrypted).not.toBe(before);
    });

    it("renews once when Google refuses a token that looked fine", async () => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u);
      google.access.clear();
      await previewed(u, b.id, s);
      expect(google.calls.filter((c) => c.path === "/token")).toHaveLength(1);
    });

    it("asks to reconnect when access was removed at Google", async () => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u);
      google.removeAccess(u.google);
      await refused(preview(u, b.id, s), 409, "SHEETS_RECONNECT_REQUIRED");
      expect(await connectionStatus(u)).toBe("needs_reauth");
      expect((await connectionOf(u))!.accessTokenEncrypted).toBeNull();
      await refused(preview(u, b.id, s), 409, "SHEETS_RECONNECT_REQUIRED");
      await connect(u);
      await previewed(u, b.id, s);
    });

    it("disconnects: forgets the tokens, revokes at Google, keeps the rows, and can be connected again", async () => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u);
      await imported(u, b.id, s);
      const sourceId = await sourceOf(u, b.id);
      const waiting = await previewed(u, b.id, sheet(u));
      const mate = await colleague(u, ["enrichment:read", "enrichment:capture"]);
      await connect(mate);
      const theirs = await previewed(mate, b.id, sheet(mate));
      google.calls = [];
      const res = await send(u, "DELETE", "/google-sheets/connection");
      expect(res.json().data).toEqual({ disconnected: true, revokedAtGoogle: true });
      expect(await connectionOf(u)).toBeUndefined();
      const [revoke] = google.calls;
      expect(revoke).toMatchObject({ path: "/revoke", method: "POST" });
      expect(revoke!.form.token).toMatch(/^refresh-secret/);
      expect(revoke!.url).not.toContain("secret");
      expect([...google.refresh.values()]).toEqual([mate.google]);
      // What was previewed through it goes too.
      expect(await status(u, b.id, waiting.id)).toMatchObject({ status: "cancelled", error: { code: "SHEETS_DISCONNECTED" }, preview: null });
      expect((await db.select().from(workbookImports).where(eq(workbookImports.id, waiting.id)))[0]!.fileKey).toBeNull();
      // Someone else's connection and preview are untouched.
      expect((await status(mate, b.id, theirs.id)).status).toBe("awaiting_confirmation");
      expect(await connectionStatus(mate)).toBe("connected");
      expect(await rowCount(b.id)).toBe(3);
      expect(await connectionStatus(u)).toBe("not_connected");

      google.calls = [];
      await refused(preview(u, b.id, s), 409, "SHEETS_NOT_CONNECTED");
      await refused(pull(u, b.id, sourceId), 409, "SHEETS_NOT_CONNECTED");
      await refused(call(u, "POST", `/${b.id}/sheets/inspect`, { spreadsheet: s.link }), 409, "SHEETS_NOT_CONNECTED");
      await refused(confirm(u, b.id, waiting.id, suggested(waiting)), 409, "IMPORT_STATE_CONFLICT");
      expect(google.calls).toEqual([]);

      await connect(u);
      s.set([...people(3), personRow(4)]);
      expect((await pulled(u, b.id, sourceId)).counts).toMatchObject({ imported: 1, alreadyImported: 3 });
    });

    it("forgets the tokens even when Google does not confirm the revocation", async () => {
      const u = await user();
      google.revokeStatus = 500;
      expect((await send(u, "DELETE", "/google-sheets/connection")).json().data).toEqual({ disconnected: true, revokedAtGoogle: false });
      expect(await connectionOf(u)).toBeUndefined();
    });
  });

  // ── Choosing a spreadsheet and tab ─────────────────────────────────────────

  describe("choosing", () => {
    const inspect = (u: User, workbookId: string, spreadsheet: string) => call(u, "POST", `/${workbookId}/sheets/inspect`, { spreadsheet });

    it("names a linked spreadsheet and its tabs, and reads no values", async () => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u);
      s.tabs.push({ sheetId: 55, title: "Old", values: [HEAD] }, { sheetId: 77, title: "Chart", values: [], sheetType: "OBJECT" });
      const res = await inspect(u, b.id, `${s.link}#gid=55`);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data).toEqual({
        spreadsheetId: s.id,
        name: "Pipeline",
        linkedSheetId: 55,
        tabs: [
          { sheetId: 0, name: "Leads", rows: 54, columns: 26, sourceId: null },
          { sheetId: 55, name: "Old", rows: 51, columns: 26, sourceId: null },
        ],
      });
      expect(google.valueReads()).toEqual([]);
      expect(google.calls.every((c) => c.method === "GET" && c.account === u.google && !c.url.includes("ya29"))).toBe(true);
      expect((await inspect(u, b.id, s.id)).json().data.linkedSheetId).toBeNull();
    });

    it("accepts only Google Sheets links, and asks Google nothing for others", async () => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u);
      for (const bad of [
        "hello",
        "https://example.com/spreadsheets/d/" + s.id,
        "http://docs.google.com/spreadsheets/d/" + s.id,
        "https://docs.google.com.evil.test/spreadsheets/d/" + s.id,
        "https://docs.google.com/document/d/" + s.id,
        "https://docs.google.com/spreadsheets/d/e/2PACX-published-copy-abcdefghijklmnop/pubhtml",
        "https://docs.google.com/spreadsheets/d/short",
        "https://docs.google.com:8443/spreadsheets/d/" + s.id,
        "file:///etc/passwd",
      ]) {
        await refused(inspect(u, b.id, bad), 422, "SHEETS_INVALID_LINK");
        await refused(call(u, "POST", `/${b.id}/sheets-imports`, { spreadsheet: bad, sheetId: 0 }), 422, "SHEETS_INVALID_LINK");
      }
      expect(google.calls).toEqual([]);
      expect((await inspect(u, b.id, `https://docs.google.com/spreadsheets/u/1/d/${s.id}/edit?usp=sharing`)).statusCode).toBe(200);
    });

    it("refuses a malformed request", async () => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u);
      const bad: unknown[] = [
        {},
        { spreadsheet: s.link },
        { sheetId: 0 },
        { spreadsheet: s.link, sheetId: "0" },
        { spreadsheet: s.link, sheetId: -1 },
        { spreadsheet: s.link, sheetId: 0, userId: MISSING },
        { spreadsheet: s.link, sheetId: 0, range: "A1:B2" },
      ];
      for (const body of bad) expect((await call(u, "POST", `/${b.id}/sheets-imports`, body)).statusCode, JSON.stringify(body)).toBe(422);
      expect(google.calls).toEqual([]);
    });

    it.each([
      ["a deleted spreadsheet", 404, undefined, 422, "SHEETS_SPREADSHEET_NOT_FOUND"],
      ["no access", 403, undefined, 422, "SHEETS_NO_ACCESS"],
      ["a missing permission", 403, "ACCESS_TOKEN_SCOPE_INSUFFICIENT", 409, "SHEETS_SCOPE_MISSING"],
      ["the API switched off", 403, "SERVICE_DISABLED", 502, "SHEETS_UNAVAILABLE"],
      ["a quota refusal", 403, "RATE_LIMIT_EXCEEDED", 429, "SHEETS_RATE_LIMITED"],
      ["a rate limit", 429, undefined, 429, "SHEETS_RATE_LIMITED"],
      ["an outage", 503, undefined, 502, "SHEETS_UNAVAILABLE"],
      ["a refused request", 400, undefined, 422, "SHEETS_REJECTED"],
    ])("explains %s", async (_what, from, reason, httpStatus, code) => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u);
      google.fail((c) => c.host === "sheets.googleapis.com", from, { times: 10, reason });
      await refused(inspect(u, b.id, s.link), httpStatus, code);
      await refused(preview(u, b.id, s), httpStatus, code);
      expect(await db.select().from(workbookImports).where(eq(workbookImports.workbookId, b.id))).toEqual([]);
      expect(await connectionStatus(u)).toBe("connected");
    });

    it("explains a tab deleted while it is being read", async () => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u);
      google.onCall = (c) => {
        if (c.range) s.tab.title = "Gone";
      };
      await refused(preview(u, b.id, s), 422, "SHEETS_TAB_NOT_FOUND");
    });

    it("retries a rate limit a few times, then gives up", async () => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u);
      google.fail((c) => c.host === "sheets.googleapis.com", 429, { times: 3 });
      expect((await inspect(u, b.id, s.link)).statusCode).toBe(200);
      expect(google.calls).toHaveLength(4);
      google.calls = [];
      google.fail((c) => c.host === "sheets.googleapis.com", 429, { times: 10 });
      await refused(inspect(u, b.id, s.link), 429, "SHEETS_RATE_LIMITED");
      expect(google.calls).toHaveLength(4);
    });

    it("explains a spreadsheet the person's account can't open", async () => {
      const [u, other] = [await user(), await user()];
      const b = await workbook(u);
      await refused(inspect(u, b.id, sheet(other).link), 422, "SHEETS_NO_ACCESS");
    });
  });

  // ── Preview ────────────────────────────────────────────────────────────────

  describe("preview", () => {
    it("shows the headings and first 20 rows with the spreadsheet and tab, and adds nothing", async () => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u, people(30));
      const item = await previewed(u, b.id, s);
      expect(item).toMatchObject({ sourceType: "google_sheets", status: "awaiting_confirmation", fileName: "Pipeline · Leads", sourceName: "Leads", sheet: { sourceId: null, spreadsheetName: "Pipeline", tabName: "Leads", pull: false }, counts: { total: 30 } });
      expect(item.preview!.headers.map((h) => h.name)).toEqual(HEAD);
      expect(item.preview!.rows).toHaveLength(20);
      expect(item.preview!.rows[0]).toEqual({ line: 2, values: personRow(1) });
      expect(item.preview!.suggestions.map((x) => x.target.newColumn.dataType)).toEqual(["text", "email", "linkedin_url", "domain"]);
      expect(item.preview!.sheet).toEqual({ spreadsheetName: "Pipeline", tabName: "Leads", unique: [true, true, true, true], source: null });
      expect(await stored(b.id)).toEqual([]);
      expect(await db.select().from(workbookColumns).where(eq(workbookColumns.workbookId, b.id))).toEqual([]);
      expect(await db.select().from(workbookSheetSources).where(eq(workbookSheetSources.workbookId, b.id))).toEqual([]);
      expect(JSON.stringify(item)).not.toMatch(SECRETS);
    });

    it("says which columns could identify rows", async () => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u, [["Same", "a@x.com", "", "x.com"], ["Same", "b@x.com", "y", "x.com"]]);
      expect((await previewed(u, b.id, s)).preview!.sheet.unique).toEqual([false, true, false, false]);
    });

    it("shows what the sheet holds only to whoever previewed it", async () => {
      const owner = await user();
      const mate = await colleague(owner, ["enrichment:read", "enrichment:capture"]);
      const b = await workbook(owner);
      const item = await previewed(owner, b.id, sheet(owner));
      const theirs = await status(mate, b.id, item.id);
      expect(theirs.preview).toBeNull();
      expect(JSON.stringify(theirs)).not.toContain("Person 1");
      expect((await call(mate, "GET", `/${b.id}/imports`)).body).not.toContain("Person 1");
      expect((await status(owner, b.id, item.id)).preview).not.toBeNull();
    });

    it("lets only the person who previewed it add it", async () => {
      const owner = await user();
      const mate = await colleague(owner, ["enrichment:read", "enrichment:capture"]);
      await connect(mate);
      const b = await workbook(owner);
      const s = sheet(owner);
      s.readers.add(mate.google);
      const item = await previewed(owner, b.id, s);
      await refused(confirm(mate, b.id, item.id, suggested(item)), 403, "SHEETS_NOT_YOURS");
      expect(await stored(b.id)).toEqual([]);
      expect((await confirm(owner, b.id, item.id, suggested(item))).statusCode).toBe(200);
    });

    it.each([
      ["connected again", async (u: User) => connect(u), 409, "SHEETS_CONNECTION_CHANGED"],
      ["access to the sheet removed", async (_u: User, s: Sheet) => void s.readers.clear(), 422, "SHEETS_NO_ACCESS"],
      ["the spreadsheet deleted", async (_u: User, s: Sheet) => void google.spreadsheets.delete(s.id), 422, "SHEETS_SPREADSHEET_NOT_FOUND"],
      ["the tab deleted", async (_u: User, s: Sheet) => void (s.tabs.length = 0), 422, "SHEETS_TAB_NOT_FOUND"],
      ["access removed at Google", async (u: User) => google.removeAccess(u.google), 409, "SHEETS_RECONNECT_REQUIRED"],
    ])("refuses to confirm after %s", async (_what, change, httpStatus, code) => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u);
      const item = await previewed(u, b.id, s);
      await change(u, s);
      await refused(confirm(u, b.id, item.id, suggested(item)), httpStatus, code);
      expect(await stored(b.id)).toEqual([]);
    });

    it.each([
      ["has headings only", { values: [HEAD] }, "NOTHING_TO_ADD", "no rows yet"],
      ["is empty", { values: [] }, "SHEET_INVALID", "must name the columns"],
      ["names no columns", { values: [["", ""], ["a", "b"]] }, "SHEET_INVALID", "must name the columns"],
      ["has too many columns", { values: [Array.from({ length: 501 }, (_, i) => `c${i}`), ["a"]], columnCount: 600 }, "SHEET_INVALID", "more than 500 columns"],
    ])("explains a tab that %s", async (_what, tab, code, words) => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u, [], tab as Partial<FakeTab>);
      const body = await refused(preview(u, b.id, s), 422, code);
      expect(JSON.stringify(body)).toContain(words);
      expect(await readdir(dir, { recursive: true }).then((files) => files.filter((f) => String(f).includes(b.id)))).toEqual([]);
    });

    it("refuses a tab with more rows than a workbook can import", async () => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u, Array.from({ length: 100_001 }, () => ["x"]), { columnCount: 4 });
      expect(JSON.stringify(await refused(preview(u, b.id, s), 422, "SHEET_INVALID"))).toContain("more than 100,000 rows");
    });

    it("gives every column a name, and keeps the headings apart", async () => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u, [], { values: [["Name", "", "name", "  Work\n email "], ["a", "b", "c", "d", "ignored"]] });
      const item = await previewed(u, b.id, s);
      expect(item.preview!.headers.map((h) => h.name)).toEqual(["Name", "Column B", "name (C)", "Work email"]);
      expect(item.preview!.rows[0]!.values).toEqual(["a", "b", "c", "d"]);
    });

    it("asks for a tab by a quoted name", async () => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u, people(1), { title: "Q4 'hot' leads!" });
      await previewed(u, b.id, s);
      expect(google.valueReads()[0]!.range).toBe("'Q4 ''hot'' leads!'!A1:Z1");
    });

    it("makes one preview for a repeated request", async () => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u);
      const key = { "idempotency-key": randomUUID() };
      const first = await preview(u, b.id, s, 0, key);
      const reads = google.calls.length;
      expect((await preview(u, b.id, s, 0, key)).json().data.id).toBe(first.json().data.id);
      expect(google.calls).toHaveLength(reads);
    });
  });

  // ── First import ───────────────────────────────────────────────────────────

  it("adds every row with its source, remembers the tab, and records the import", async () => {
    const u = await user();
    const b = await workbook(u);
    const s = sheet(u);
    const done = await imported(u, b.id, s);
    expect(done).toMatchObject({ status: "completed", background: false, counts: { total: 3, processed: 3, imported: 3, duplicates: 0, skipped: 0, failed: 0, alreadyImported: 0 }, sheet: { pull: false } });
    const rows = await stored(b.id);
    expect(rows[0]!.values).toEqual({ Name: "Person 1", Email: "p1@company1.com", LinkedIn: "https://www.linkedin.com/in/person-1", Domain: "company1.com" });
    const [source] = await db.select().from(workbookSheetSources).where(eq(workbookSheetSources.workbookId, b.id));
    expect(rows[0]!.from).toEqual({
      type: "google_sheets",
      spreadsheetId: s.id,
      spreadsheetName: "Pipeline",
      sheetId: 0,
      tabName: "Leads",
      sourceId: source!.id,
      importId: done.id,
      importedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    });
    expect(await rowCount(b.id)).toBe(3);
    expect(await sources(u, b.id)).toMatchObject([{ id: source!.id, tabName: "Leads", idColumn: null, rows: 3, lastPulledAt: expect.any(String), runningImportId: null }]);
    expect(await db.select().from(workbookSheetKeys).where(eq(workbookSheetKeys.sourceId, source!.id))).toHaveLength(3);
    const [event, ...more] = await events(b.id);
    expect(more).toEqual([]);
    expect(event).toMatchObject({ actorId: u.userId, afterState: { source: "google_sheets", spreadsheetName: "Pipeline", tabName: "Leads", pull: false, status: "completed", rows: 3, rowCount: 3, duplicates: 0, skipped: 0, failed: 0, alreadyImported: 0 } });
    const feed = (await call(u, "GET", `/${b.id}/activity`)).json().data.find((e: any) => e.type === "rows.added");
    expect(feed).toMatchObject({ actor: { id: u.userId }, details: { source: "google_sheets", tabName: "Leads", status: "completed", rows: 3, pull: false } });
    // The copy of the tab is removed once it has been imported.
    expect((await db.select().from(workbookImports).where(eq(workbookImports.id, done.id)))[0]!.fileKey).toBeNull();
  });

  it("imports a large tab in the background, read in blocks, with real progress and nothing lost to gaps", async () => {
    const u = await user();
    const b = await workbook(u);
    const rows = people(26_000);
    // A gap longer than a whole block, and a value on several lines.
    rows.splice(100, 0, ...Array.from({ length: 5_200 }, () => [] as string[]));
    rows[0] = ["Person\n1\r\nwith lines", ...personRow(1).slice(1)];
    rows[5_400] = ["Bad", "not-an-email", "", ""];
    const s = sheet(u, rows, { rowCount: 40_000, columnCount: 4 });
    const item = await previewed(u, b.id, s);
    expect(item.counts.total).toBe(26_000);
    expect(google.valueReads().length).toBeGreaterThan(5);
    google.calls = [];
    // A value that isn't an address leaves the column suggested as text, so the type is chosen here.
    const mapping = suggested(item);
    mapping.columns[1] = { header: 1, newColumn: { name: "Email", dataType: "email" } };
    const res = await confirm(u, b.id, item.id, mapping);
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json().data).toMatchObject({ status: "queued", background: true });
    expect(queue.jobs).toEqual([{ importId: item.id, workspaceId: u.workspaceId }]);
    await work(item.id);
    const done = await status(u, b.id, item.id);
    expect(done).toMatchObject({ status: "completed", progress: 100, counts: { processed: 26_000, imported: 25_999, failed: 1 } });
    // The import used the copy: Google was only asked whether the tab is still there.
    expect(google.valueReads()).toEqual([]);
    // Row 2 is the first data row; the gap and the earlier lines do not move the bad row's number.
    expect((await report(u, b.id, done.id))[1]).toMatch(new RegExp(`^"${5_402}","Invalid value"`));
    expect((await stored(b.id))[0]!.values.Name).toBe("Person\n1\nwith lines");
  });

  it("imports into existing columns, reporting values that don't fit with their row in the sheet", async () => {
    const u = await user();
    const b = await workbook(u, [{ name: "Who" }, { name: "Mail", dataType: "email" }, { name: "Count", dataType: "number" }]);
    const s = sheet(u, [personRow(1), [], ["Second", "wrong", "", ""], ["Third", "", "", ""]]);
    const item = await previewed(u, b.id, s);
    const res = await confirm(u, b.id, item.id, { columns: [{ header: 0, columnId: b.col.Who }, { header: 1, columnId: b.col.Mail }], dedupe: { key: "none" } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.counts).toMatchObject({ total: 3, imported: 2, failed: 1 });
    expect((await stored(b.id)).map((r) => r.values)).toEqual([{ Who: "Person 1", Mail: "p1@company1.com" }, { Who: "Third" }]);
    expect((await report(u, b.id, item.id)).slice(0, 2)).toEqual([expect.stringContaining('"Row in sheet","Result","Reason","Name","Email"'), expect.stringMatching(/^"4","Invalid value".*"Second","wrong"/)]);
  });

  it("refuses a bad mapping or identity column, and changes nothing", async () => {
    const u = await user();
    const b = await workbook(u, [{ name: "Find", type: "enrichment" }]);
    const item = await previewed(u, b.id, sheet(u));
    await refused(confirm(u, b.id, item.id, { columns: [{ header: 0, columnId: b.col.Find }], dedupe: { key: "none" } }), 422, "INVALID_IMPORT_MAPPING");
    await refused(confirm(u, b.id, item.id, suggested(item, { idColumn: 9 })), 422, "INVALID_IMPORT_MAPPING");
    expect((await confirm(u, b.id, item.id, suggested(item, { idColumn: -1 }))).statusCode).toBe(422);
    expect(await stored(b.id)).toEqual([]);
    expect(await db.select().from(workbookSheetSources).where(eq(workbookSheetSources.workbookId, b.id))).toEqual([]);
  });

  it("takes an identity column only for sheets", async () => {
    const u = await user();
    const b = await workbook(u, [{ name: "Who" }]);
    const upload = await app.inject({ method: "POST", url: `${URL_BASE}/${b.id}/imports`, remoteAddress: u.ip, headers: { ...u.headers, "content-type": "text/csv", "x-file-name": "a.csv" }, payload: "Who\nA\n" });
    await refused(confirm(u, b.id, upload.json().data.id, { columns: [{ header: 0, columnId: b.col.Who }], dedupe: { key: "none" }, idColumn: 0 }), 422, "INVALID_IMPORT_MAPPING");
  });

  it.each([
    ["email", "Email", "email", "P1@Company1.com", 1],
    ["linkedin_url", "LinkedIn", "linkedin_url", "https://uk.linkedin.com/in/person-1/?x=1", 2],
    ["domain", "Domain", "domain", "company1.com", 3],
  ])("skips duplicates by %s, within the sheet and against rows already there, changing none", async (key, name, dataType, existing, header) => {
    const u = await user();
    const b = await workbook(u, [{ name, dataType }, { name: "Name" }]);
    expect((await call(u, "POST", `/${b.id}/rows`, { cells: { [b.col[name]!]: existing, [b.col.Name!]: "Kept" } })).statusCode).toBe(201);
    const rows = people(4);
    rows[3] = [`Again`, ...personRow(3).slice(1)];
    const done = await imported(u, b.id, sheet(u, rows), { dedupe: { key, header } });
    expect(done.counts).toMatchObject({ processed: 4, imported: 2, duplicates: 2 });
    expect((await stored(b.id)).map((r) => r.values.Name)).toEqual(["Kept", "Person 2", "Person 3"]);
    expect((await stored(b.id))[0]!.values[name]).toBe(existing);
    // Pulling again changes nothing: the two added are known, the two duplicates are still duplicates.
    expect((await pulled(u, b.id)).counts).toMatchObject({ imported: 0, alreadyImported: 2, duplicates: 2 });
  });

  it("fills the workbook to its limit, and adds the rest on a later pull when there is room", async () => {
    const u = await user();
    await setEntitlement(u.workspaceId, "workbooks.row_limit", 3);
    const b = await workbook(u);
    const s = sheet(u, people(5));
    expect((await imported(u, b.id, s)).counts).toMatchObject({ imported: 3, failed: 2 });
    await refused(pull(u, b.id, await sourceOf(u, b.id)), 422, "ROW_LIMIT_EXCEEDED");
    await setEntitlement(u.workspaceId, "workbooks.row_limit", 10);
    expect((await pulled(u, b.id)).counts).toMatchObject({ imported: 2, alreadyImported: 3 });
    expect(await rowCount(b.id)).toBe(5);
  });

  // ── Pull new rows ──────────────────────────────────────────────────────────

  describe("pull new rows", () => {
    it("adds only rows not added before, wherever they moved, and changes nothing already there", async () => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u, people(4));
      await imported(u, b.id, s);
      const before = await stored(b.id);
      s.set([personRow(6), personRow(3), [], personRow(1), personRow(5), personRow(2)]);
      const done = await pulled(u, b.id);
      expect(done).toMatchObject({ status: "completed", sheet: { pull: true, tabName: "Leads" }, counts: { total: 5, processed: 5, imported: 2, alreadyImported: 3, duplicates: 0, failed: 0 } });
      // Person 4 left the sheet and stays in the workbook.
      expect((await names(b.id))).toEqual(["Person 1", "Person 2", "Person 3", "Person 4", "Person 6", "Person 5"]);
      expect((await stored(b.id)).slice(0, 4)).toEqual(before);
      expect(done.report.available).toBe(false);
      expect((await events(b.id)).at(-1)!.afterState).toMatchObject({ pull: true, rows: 2, alreadyImported: 3, status: "completed" });
    });

    it("records a pull that finds nothing new, and never adds a row twice however often it is asked", async () => {
      const u = await user();
      const b = await workbook(u);
      await imported(u, b.id, sheet(u));
      for (let i = 0; i < 3; i += 1) expect((await pulled(u, b.id)).counts).toMatchObject({ imported: 0, alreadyImported: 3 });
      expect(await rowCount(b.id)).toBe(3);
      expect(await events(b.id)).toHaveLength(4);
    });

    it("without an ID column, takes an edited row as a new one, and tells identical rows apart by number", async () => {
      const u = await user();
      const b = await workbook(u);
      const twin = ["Twin", "t@x.com", "", ""];
      const s = sheet(u, [twin, twin, personRow(1)]);
      expect((await imported(u, b.id, s)).counts.imported).toBe(3);
      s.set([personRow(1), twin, twin, twin]);
      expect((await pulled(u, b.id)).counts).toMatchObject({ imported: 1, alreadyImported: 3 });
      s.set([["Person 1 (edited)", ...personRow(1).slice(1)], twin, twin, twin]);
      expect((await pulled(u, b.id)).counts).toMatchObject({ imported: 1, alreadyImported: 3 });
      expect(await rowCount(b.id)).toBe(5);
    });

    it("with an ID column, knows an edited and moved row, and reports rows without one", async () => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u, people(3));
      expect((await imported(u, b.id, s, { idColumn: 1 })).counts.imported).toBe(3);
      expect((await sources(u, b.id))[0]!.idColumn).toBe("Email");
      s.set([
        ["New", "new@x.com", "", ""],
        ["Person 3 renamed", "p3@company3.com", "", "changed.com"],
        ["No id", "", "", ""],
        ["Repeat", "new@x.com", "", ""],
        personRow(1),
      ]);
      const done = await pulled(u, b.id);
      expect(done.counts).toMatchObject({ imported: 1, alreadyImported: 2, skipped: 1, duplicates: 1 });
      expect(await names(b.id)).toEqual(["Person 1", "Person 2", "Person 3", "New"]);
      const lines = await report(u, b.id, done.id);
      expect(lines.find((l) => l.startsWith('"4"'))).toContain("ID column “Email” is empty");
      expect(lines.find((l) => l.startsWith('"5"'))).toContain("Same ID as an earlier row");
    });

    it("counts a row repeated further down as repeated, also across the chunks of a long tab", async () => {
      const u = await user();
      const b = await workbook(u);
      const rows = people(1_500);
      rows.push(personRow(2));
      const s = sheet(u, rows);
      expect((await imported(u, b.id, s, { idColumn: 1 })).counts).toMatchObject({ imported: 1_500, duplicates: 1, alreadyImported: 0 });
    });

    it("doesn't add again a row that was deleted from the workbook", async () => {
      const u = await user();
      const b = await workbook(u);
      await imported(u, b.id, sheet(u));
      const [first] = await stored(b.id);
      expect((await call(u, "DELETE", `/${b.id}/rows/${first!.id}`)).statusCode).toBe(200);
      expect((await pulled(u, b.id)).counts).toMatchObject({ imported: 0, alreadyImported: 3 });
    });

    it("follows headings when columns move, ignores new ones, and survives the tab being renamed", async () => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u, people(2));
      await imported(u, b.id, s);
      s.tab.title = "Renamed";
      s.tab.values = [
        ["Notes", "domain", "Email", "LinkedIn", "Name"],
        ...[1, 2, 3].map((i) => ["new note", personRow(i)[3]!, personRow(i)[1]!, personRow(i)[2]!, personRow(i)[0]!]),
      ];
      const done = await pulled(u, b.id);
      expect(done).toMatchObject({ status: "completed", counts: { imported: 1, alreadyImported: 2 }, sheet: { tabName: "Renamed" } });
      expect((await stored(b.id))[2]!.values).toEqual({ Name: "Person 3", Email: "p3@company3.com", LinkedIn: "https://www.linkedin.com/in/person-3", Domain: "company3.com" });
      expect((await sources(u, b.id))[0]!.tabName).toBe("Renamed");
    });

    it("stops, saying which, when a heading it fills from is gone", async () => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u);
      await imported(u, b.id, s);
      s.tab.values[0] = ["Name", "E-mail address", "LinkedIn", "Domain"];
      const done = await pulled(u, b.id);
      expect(done).toMatchObject({ status: "failed", error: { code: "SHEET_HEADING_MISSING" }, counts: { imported: 0 } });
      expect(done.error!.message).toContain("headed “Email”");
    });

    it("refuses when a column it fills is gone", async () => {
      const u = await user();
      const b = await workbook(u);
      await imported(u, b.id, sheet(u));
      const [column] = await db.select().from(workbookColumns).where(and(eq(workbookColumns.workbookId, b.id), eq(workbookColumns.name, "Domain")));
      await db.delete(workbookColumns).where(eq(workbookColumns.id, column!.id));
      await refused(pull(u, b.id, await sourceOf(u, b.id)), 409, "SHEET_MAPPING_CHANGED");
    });

    it("finishes with nothing when the tab has been emptied", async () => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u);
      await imported(u, b.id, s);
      s.set([]);
      expect(await pulled(u, b.id)).toMatchObject({ status: "completed", counts: { total: 0, imported: 0 } });
    });

    it.each([
      ["the spreadsheet was deleted", (s: Sheet) => void google.spreadsheets.delete(s.id), 422, "SHEETS_SPREADSHEET_NOT_FOUND"],
      ["the tab was deleted", (s: Sheet) => void (s.tabs[0] = { sheetId: 9, title: "Leads", values: [HEAD] }), 422, "SHEETS_TAB_NOT_FOUND"],
      ["access was taken away", (s: Sheet) => void s.readers.clear(), 422, "SHEETS_NO_ACCESS"],
    ])("explains when %s, and starts nothing", async (_what, change, httpStatus, code) => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u);
      await imported(u, b.id, s);
      const sourceId = await sourceOf(u, b.id);
      change(s);
      await refused(pull(u, b.id, sourceId), httpStatus, code);
      expect(await db.select().from(workbookImports).where(eq(workbookImports.workbookId, b.id))).toHaveLength(1);
    });

    it("reads the tab through the account of whoever pulls", async () => {
      const owner = await user();
      const mate = await colleague(owner, ["enrichment:read", "enrichment:capture"]);
      const b = await workbook(owner);
      const s = sheet(owner);
      await imported(owner, b.id, s);
      const sourceId = await sourceOf(owner, b.id);
      await refused(pull(mate, b.id, sourceId), 409, "SHEETS_NOT_CONNECTED");
      await connect(mate);
      await refused(pull(mate, b.id, sourceId), 422, "SHEETS_NO_ACCESS");
      s.readers.add(mate.google);
      s.set([...people(3), personRow(4)]);
      google.calls = [];
      expect((await pulled(mate, b.id, sourceId)).counts.imported).toBe(1);
      expect(google.calls.every((c) => c.account === mate.google)).toBe(true);
      expect((await events(b.id)).at(-1)!.actorId).toBe(mate.userId);
    });

    it("pulls a large tab in the background, and answers a second request with the same pull", async () => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u, people(1_200));
      await imported(u, b.id, s);
      const sourceId = await sourceOf(u, b.id);
      s.set(people(1_700));
      queue.jobs.length = 0;
      const first = await pull(u, b.id, sourceId);
      expect(first.statusCode, first.body).toBe(202);
      // Asking again is answered from what is under way, even by someone who has no connection.
      const mate = await colleague(u, ["enrichment:read", "enrichment:capture"]);
      google.calls = [];
      expect((await pull(mate, b.id, sourceId)).json()).toMatchObject({ alreadyRunning: true, data: { id: first.json().data.id } });
      expect(google.calls).toEqual([]);
      expect(first.json()).toMatchObject({ alreadyRunning: false, data: { status: "queued", background: true, counts: { total: 0 } } });
      const [again, third] = await Promise.all([pull(u, b.id, sourceId), pull(u, b.id, sourceId)]);
      for (const res of [again, third]) expect(res.json()).toMatchObject({ alreadyRunning: true, data: { id: first.json().data.id } });
      expect((await sources(u, b.id))[0]!.runningImportId).toBe(first.json().data.id);
      expect(queue.jobs).toHaveLength(1);
      await work(first.json().data.id);
      expect(await status(u, b.id, first.json().data.id)).toMatchObject({ status: "completed", counts: { total: 1_700, imported: 500, alreadyImported: 1_200 } });
      expect(await rowCount(b.id)).toBe(1_700);
    });

    it("moves a pull into the background when the tab turns out to be large", async () => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u, people(10));
      await imported(u, b.id, s);
      s.set(people(1_300));
      queue.jobs.length = 0;
      const res = await pull(u, b.id, await sourceOf(u, b.id));
      expect(res.statusCode, res.body).toBe(202);
      expect(res.json().data).toMatchObject({ status: "processing", background: true, counts: { total: 1_300, imported: 0 } });
      expect(queue.jobs).toHaveLength(1);
      await work(res.json().data.id);
      expect(await rowCount(b.id)).toBe(1_300);
    });

    it("runs concurrent pulls without adding a row twice", async () => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u, people(50));
      await imported(u, b.id, s);
      const sourceId = await sourceOf(u, b.id);
      s.set(people(400));
      const results = await Promise.all(Array.from({ length: 6 }, () => pull(u, b.id, sourceId)));
      for (const res of results) expect([200, 202], res.body).toContain(res.statusCode);
      expect(await rowCount(b.id)).toBe(400);
      expect(new Set(await names(b.id)).size).toBe(400);
    });

    it("replays a keyed request", async () => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u);
      await imported(u, b.id, s);
      const sourceId = await sourceOf(u, b.id);
      s.set(people(5));
      const key = { "idempotency-key": randomUUID() };
      const first = await pull(u, b.id, sourceId, key);
      expect((await pull(u, b.id, sourceId, key)).json().data.id).toBe(first.json().data.id);
      expect(await db.select().from(workbookImports).where(eq(workbookImports.workbookId, b.id))).toHaveLength(2);
    });

    it("tries again after Google fails while a pull reads the tab, adding nothing twice", async () => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u, people(1_100));
      await imported(u, b.id, s);
      s.set(people(2_600));
      const id = (await pull(u, b.id, await sourceOf(u, b.id))).json().data.id as string;
      google.fail(range(2), 503, { times: 4 });
      await expect(work(id)).rejects.toThrow("Try later (SHEETS_UNAVAILABLE)");
      expect(await status(u, b.id, id)).toMatchObject({ status: "processing", error: null, counts: { total: 0, processed: 0 } });
      // The last attempt of a job doesn't give up on a busy Google either.
      google.fail(range(2), 429, { times: 4 });
      await expect(work(id, true)).rejects.toThrow("Try later (SHEETS_RATE_LIMITED)");
      await work(id);
      expect(await status(u, b.id, id)).toMatchObject({ status: "completed", counts: { total: 2_600, imported: 1_500, alreadyImported: 1_100 } });
      expect(new Set(await names(b.id)).size).toBe(2_600);
      expect(await rowCount(b.id)).toBe(2_600);
    });

    it("resumes from its copy after failing between chunks, even if the sheet changed", async () => {
      const u = await user();
      const b = await workbook(u);
      // The same row early and again in the chunk that fails: both are rows of their own.
      const rows = people(2_500);
      rows[1_200] = personRow(1);
      const s = sheet(u, rows);
      const item = await previewed(u, b.id, s);
      expect((await confirm(u, b.id, item.id, suggested(item))).statusCode).toBe(202);
      await withFailingCellInserts(sql, `wb2_sheet_chunk_${suffix}`, `new.value = '"Person 1700"'::jsonb`, async () => {
        await expect(work(item.id)).rejects.toThrow();
      });
      const part = await status(u, b.id, item.id);
      expect(part.status).toBe("processing");
      expect(part.counts.imported).toBeGreaterThan(0);
      s.set([]);
      google.calls = [];
      await work(item.id);
      expect(await status(u, b.id, item.id)).toMatchObject({ status: "completed", counts: { imported: 2_500, duplicates: 0, alreadyImported: 0 } });
      expect(google.calls).toEqual([]);
      expect(await rowCount(b.id)).toBe(2_500);
      expect((await names(b.id)).filter((name) => name === "Person 1")).toHaveLength(2);
    });

    it("still flags a repeated ID when the import resumes after the first of them", async () => {
      const u = await user();
      const b = await workbook(u);
      const rows = people(2_500);
      rows[1_200] = personRow(1);
      const item = await previewed(u, b.id, sheet(u, rows));
      await confirm(u, b.id, item.id, suggested(item, { idColumn: 1 }));
      await withFailingCellInserts(sql, `wb2_sheet_idres_${suffix}`, `new.value = '"Person 1700"'::jsonb`, async () => {
        await expect(work(item.id)).rejects.toThrow();
      });
      await work(item.id);
      expect((await status(u, b.id, item.id)).counts).toMatchObject({ imported: 2_499, duplicates: 1, alreadyImported: 0 });
    });

    it("fails after repeated unexpected errors, keeping what it added, and a pull adds the rest once", async () => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u, people(2_500));
      const item = await previewed(u, b.id, s);
      await confirm(u, b.id, item.id, suggested(item));
      await withFailingCellInserts(sql, `wb2_sheet_fail_${suffix}`, `new.value = '"Person 1700"'::jsonb`, async () => {
        await expect(work(item.id, true)).rejects.toThrow();
      });
      const failed = await status(u, b.id, item.id);
      expect(failed).toMatchObject({ status: "failed", error: { code: "IMPORT_FAILED" } });
      expect(failed.error!.message).toContain("Pull new rows");
      const added = await rowCount(b.id);
      expect((await pulled(u, b.id)).counts).toMatchObject({ imported: 2_500 - added, alreadyImported: added });
      expect(new Set(await names(b.id)).size).toBe(2_500);
    });

    it("stops a running import when Google Sheets is disconnected, keeping the rows", async () => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u, people(1_100));
      await imported(u, b.id, s);
      s.set(people(2_000));
      const queued = (await pull(u, b.id, await sourceOf(u, b.id))).json().data.id as string;
      await send(u, "DELETE", "/google-sheets/connection");
      google.calls = [];
      await work(queued);
      expect(await status(u, b.id, queued)).toMatchObject({ status: "failed", error: { code: "SHEETS_DISCONNECTED" }, counts: { imported: 0 } });
      expect(google.calls).toEqual([]);
      expect(await rowCount(b.id)).toBe(1_100);
      expect((await db.select().from(workbookImports).where(eq(workbookImports.id, queued)))[0]!.fileKey).toBeNull();
    });

    it("stops between chunks when disconnected while rows are being added", async () => {
      const u = await user();
      const b = await workbook(u);
      const item = await previewed(u, b.id, sheet(u, people(2_500)));
      await confirm(u, b.id, item.id, suggested(item));
      // The first chunk of rows lands, then the connection goes.
      await sql.unsafe(`create function wb2_sheet_gone_${suffix}() returns trigger language plpgsql as $$ begin delete from google_sheets_connections where user_id = '${u.userId}'; return new; end $$`);
      await sql.unsafe(`create trigger wb2_sheet_gone_${suffix} after update of counts on workbook_imports for each row when (new.id = '${item.id}') execute function wb2_sheet_gone_${suffix}()`);
      try {
        await work(item.id);
      } finally {
        await sql.unsafe(`drop trigger wb2_sheet_gone_${suffix} on workbook_imports`);
        await sql.unsafe(`drop function wb2_sheet_gone_${suffix}()`);
      }
      const done = await status(u, b.id, item.id);
      expect(done).toMatchObject({ status: "failed", error: { code: "SHEETS_DISCONNECTED" } });
      expect(done.counts.imported).toBeGreaterThan(0);
      expect(done.counts.imported).toBeLessThan(2_500);
      expect(await rowCount(b.id)).toBe(done.counts.imported);
    });

    it.each([
      ["removed at Google", async (u: User) => google.removeAccess(u.google), "SHEETS_RECONNECT_REQUIRED"],
      ["connected again", async (u: User) => connect(u), "SHEETS_CONNECTION_CHANGED"],
    ])("stops a queued pull when access is %s", async (_what, change, code) => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u, people(1_100));
      await imported(u, b.id, s);
      const queued = (await pull(u, b.id, await sourceOf(u, b.id))).json().data.id as string;
      await change(u);
      await work(queued);
      expect(await status(u, b.id, queued)).toMatchObject({ status: "failed", error: { code } });
    });

    it("adds nothing from a copy once the connection needs reconnecting", async () => {
      const u = await user();
      const b = await workbook(u);
      const item = await previewed(u, b.id, sheet(u, people(1_100)));
      await confirm(u, b.id, item.id, suggested(item));
      await db.update(googleSheetsConnections).set({ status: "needs_reauth" }).where(eq(googleSheetsConnections.userId, u.userId));
      await work(item.id);
      expect(await status(u, b.id, item.id)).toMatchObject({ status: "failed", error: { code: "SHEETS_RECONNECT_REQUIRED" }, counts: { imported: 0 } });
    });

    it.each([
      ["deleted", async (id: string) => void (await db.delete(workbookColumns).where(eq(workbookColumns.id, id)))],
      ["given another type", async (id: string) => void (await db.update(workbookColumns).set({ config: { dataType: "number" } }).where(eq(workbookColumns.id, id)))],
    ])("stops a queued pull when a column it fills is %s", async (_what, change) => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u, people(1_100));
      await imported(u, b.id, s);
      s.set(people(1_200));
      const queued = (await pull(u, b.id, await sourceOf(u, b.id))).json().data.id as string;
      const [column] = await db.select().from(workbookColumns).where(and(eq(workbookColumns.workbookId, b.id), eq(workbookColumns.name, "Domain")));
      await change(column!.id);
      await work(queued);
      expect(await status(u, b.id, queued)).toMatchObject({ status: "failed", error: { code: "MAPPING_CHANGED" }, counts: { imported: 0 } });
    });

    it("keeps how a tab's rows are recognised when it is imported again", async () => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u);
      await imported(u, b.id, s, { idColumn: 1 });
      const again = await previewed(u, b.id, s);
      expect(again.preview!.sheet.source).toMatchObject({ idColumn: 1, idHeading: "Email" });
      expect(again.preview!.suggestions.every((x) => x.target?.columnId)).toBe(true);
      await refused(confirm(u, b.id, again.id, suggested(again)), 409, "SHEET_IDENTITY_CHANGED");
      await refused(confirm(u, b.id, again.id, suggested(again, { idColumn: 0 })), 409, "SHEET_IDENTITY_CHANGED");
      s.set(people(4));
      expect((await confirm(u, b.id, again.id, suggested(again, { idColumn: 1 }))).json().data.counts).toMatchObject({ imported: 0, alreadyImported: 3 });
      // The copy previewed held three rows; the fourth comes with a pull.
      expect((await pulled(u, b.id)).counts).toMatchObject({ imported: 1, alreadyImported: 3 });
      expect(await sources(u, b.id)).toHaveLength(1);
    });

    it("recognises rows by the first columns even when a later import fills more", async () => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u);
      const item = await previewed(u, b.id, s);
      await confirm(u, b.id, item.id, { columns: suggested(item).columns.slice(0, 2), dedupe: { key: "none" } });
      const again = await previewed(u, b.id, s);
      await refused(confirm(u, b.id, again.id, { columns: [{ header: 2, newColumn: { name: "Profile", dataType: "linkedin_url" } }], dedupe: { key: "none" } }), 409, "SHEET_IDENTITY_CHANGED");
      await refused(confirm(u, b.id, again.id, { columns: suggested(again).columns, dedupe: { key: "none" }, idColumn: 1 }), 409, "SHEET_IDENTITY_CHANGED");
      const more = [...suggested(again).columns, { header: 2, newColumn: { name: "Profile", dataType: "linkedin_url" } }];
      expect((await confirm(u, b.id, again.id, { columns: more, dedupe: { key: "none" } })).json().data.counts).toMatchObject({ imported: 0, alreadyImported: 3 });
      expect((await pulled(u, b.id)).counts).toMatchObject({ imported: 0, alreadyImported: 3 });
    });

    it("won't import a tab again, or forget it, while it is being pulled", async () => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u, people(1_100));
      await imported(u, b.id, s);
      const again = await previewed(u, b.id, s);
      const sourceId = await sourceOf(u, b.id);
      expect((await pull(u, b.id, sourceId)).statusCode).toBe(202);
      await refused(confirm(u, b.id, again.id, suggested(again)), 409, "SHEET_IMPORT_RUNNING");
      await refused(call(u, "DELETE", `/${b.id}/sheet-sources/${sourceId}`), 409, "SHEET_IMPORT_RUNNING");
    });

    it("forgets a tab: its rows stay, and a new import starts afresh", async () => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u);
      await imported(u, b.id, s);
      const sourceId = await sourceOf(u, b.id);
      expect((await call(u, "DELETE", `/${b.id}/sheet-sources/${sourceId}`)).statusCode).toBe(200);
      expect(await sources(u, b.id)).toEqual([]);
      expect(await db.select().from(workbookSheetKeys).where(eq(workbookSheetKeys.sourceId, sourceId))).toEqual([]);
      await refused(pull(u, b.id, sourceId), 404, "NOT_FOUND");
      expect(await rowCount(b.id)).toBe(3);
      expect((await imported(u, b.id, s, { dedupe: { key: "email", header: 1 } })).counts).toMatchObject({ imported: 0, duplicates: 3 });
    });

    it("keeps pulling in a copy with rows, without adding them again, and not in a copy without", async () => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u);
      await imported(u, b.id, s);
      const copy = (await call(u, "POST", `/${b.id}/duplicate`, { includeRows: true })).json().data.id as string;
      s.set(people(4));
      expect((await pulled(u, copy)).counts).toMatchObject({ imported: 1, alreadyImported: 3 });
      expect((await stored(copy))[3]!.values.Email).toBe("p4@company4.com");
      expect(await rowCount(b.id)).toBe(3);
      const empty = (await call(u, "POST", `/${b.id}/duplicate`, { includeRows: false })).json().data.id as string;
      expect(await sources(u, empty)).toEqual([]);
    });
  });

  // ── What an import never does ──────────────────────────────────────────────

  it("runs and charges nothing, and only reads Google", async () => {
    const u = await user();
    const b = await workbook(u, [{ name: "Find", type: "enrichment" }, { name: "Shout", type: "formula" }, { name: "Think", type: "ai" }, { name: "Send", type: "action" }]);
    const s = sheet(u);
    const spending = async () => ({
      balance: await db.select().from(creditBalances).where(eq(creditBalances.workspaceId, u.workspaceId)),
      ledger: await db.select().from(creditTransactions).where(eq(creditTransactions.workspaceId, u.workspaceId)),
      jobs: await db.select().from(enrichmentJobs).where(eq(enrichmentJobs.workspaceId, u.workspaceId)),
      results: await db.select().from(enrichmentResults).where(eq(enrichmentResults.workspaceId, u.workspaceId)),
      async: await db.select().from(asyncJobs).where(eq(asyncJobs.workspaceId, u.workspaceId)),
      runs: await db.select().from(workbookRuns).where(eq(workbookRuns.workbookId, b.id)),
    });
    const before = await spending();
    await imported(u, b.id, s);
    s.set(people(5));
    await pulled(u, b.id);
    expect(await spending()).toEqual(before);
    const written = await db.select().from(workbookCells).where(eq(workbookCells.workbookId, b.id));
    expect(written.some((c) => [b.col.Find, b.col.Shout, b.col.Think, b.col.Send].includes(c.columnId))).toBe(false);
    expect(google.calls.filter((c) => c.host === "sheets.googleapis.com" && c.method !== "GET")).toEqual([]);
  });

  it("never returns or stores a token outside the connection", async () => {
    const u = await user();
    const b = await workbook(u);
    const s = sheet(u);
    const done = await imported(u, b.id, s);
    await pulled(u, b.id);
    const answers = await Promise.all([
      send(u, "GET", "/google-sheets/connection"),
      call(u, "GET", `/${b.id}/sheet-sources`),
      call(u, "GET", `/${b.id}/imports`),
      call(u, "GET", `/${b.id}/imports/${done.id}`),
      call(u, "GET", `/${b.id}/rows`),
      call(u, "GET", `/${b.id}/activity`),
      call(u, "POST", `/${b.id}/sheets/inspect`, { spreadsheet: s.link }),
    ]);
    for (const res of answers) expect(res.body).not.toMatch(/secret|enc:v1|TokenEncrypted|stateHash/);
    const [kept] = await sql`select (select jsonb_agg(to_jsonb(i)) from workbook_imports i where workbook_id = ${b.id})::text as imports,
      (select jsonb_agg(to_jsonb(r)) from workbook_rows r where workbook_id = ${b.id})::text as rows,
      (select jsonb_agg(to_jsonb(x)) from workbook_sheet_sources x where workbook_id = ${b.id})::text as sources,
      (select jsonb_agg(to_jsonb(a)) from audit_logs a where workspace_id = ${u.workspaceId})::text as audit`;
    expect(`${kept!.imports}${kept!.rows}${kept!.sources}${kept!.audit}`).not.toMatch(SECRETS);
  });

  // ── Who may ────────────────────────────────────────────────────────────────

  describe("access", () => {
    it("lets only people who may edit the workbook read sheets into it; viewers see which tabs it pulls from", async () => {
      const owner = await user();
      const b = await workbook(owner);
      const s = sheet(owner);
      await imported(owner, b.id, s);
      const sourceId = await sourceOf(owner, b.id);
      const viewer = await colleague(owner, ["enrichment:read"]);
      await connect(viewer);
      s.readers.add(viewer.google);
      google.calls = [];
      for (const res of [
        call(viewer, "POST", `/${b.id}/sheets/inspect`, { spreadsheet: s.link }),
        preview(viewer, b.id, s),
        pull(viewer, b.id, sourceId),
        call(viewer, "DELETE", `/${b.id}/sheet-sources/${sourceId}`),
      ]) {
        expect((await res).statusCode).toBe(403);
      }
      expect(google.calls).toEqual([]);
      expect(await sources(viewer, b.id)).toHaveLength(1);
    });

    it("hides another workspace's workbook, sheet and imports", async () => {
      const [mine, theirs] = [await user(), await user()];
      const a = await workbook(mine);
      const b = await workbook(theirs);
      const s = sheet(theirs);
      s.readers.add(mine.google);
      await imported(theirs, b.id, s);
      const waiting = await previewed(theirs, b.id, sheet(theirs));
      const sourceId = await sourceOf(theirs, b.id);
      google.calls = [];
      for (const res of [
        call(mine, "GET", `/${b.id}/sheet-sources`),
        call(mine, "POST", `/${b.id}/sheets/inspect`, { spreadsheet: s.link }),
        preview(mine, b.id, s),
        preview(mine, MISSING, s),
        pull(mine, b.id, sourceId),
        pull(mine, a.id, sourceId),
        call(mine, "DELETE", `/${b.id}/sheet-sources/${sourceId}`),
        call(mine, "DELETE", `/${a.id}/sheet-sources/${sourceId}`),
        confirm(mine, a.id, waiting.id, suggested(waiting)),
        call(mine, "GET", `/${a.id}/imports/${waiting.id}`),
      ]) {
        await refused(res, 404, "NOT_FOUND");
      }
      expect(google.calls).toEqual([]);
      expect(await sources(theirs, b.id)).toHaveLength(1);
      expect(await rowCount(b.id)).toBe(3);
      expect((await call(mine, "DELETE", `/${a.id}`)).statusCode).toBe(200);
      await refused(preview(mine, a.id, s), 404, "NOT_FOUND");
    });

    it("needs Workbooks V2", async () => {
      const u = await user();
      const b = await workbook(u);
      const s = sheet(u);
      await setEntitlement(u.workspaceId, "feature.workbooks_v2", false);
      for (const res of [preview(u, b.id, s), call(u, "GET", `/${b.id}/sheet-sources`)]) expect((await res).statusCode).toBe(403);
      // Disconnecting is never blocked.
      expect((await send(u, "DELETE", "/google-sheets/connection")).statusCode).toBe(200);
    });
  });

  // ── Suppression (WB2-027) ──────────────────────────────────────────────────

  describe("suppression", () => {
    it("imports suppressed people from a sheet and marks their rows, also those a later pull adds", async () => {
      const u = await user();
      await db.insert(schema.suppressions).values([
        { workspaceId: u.workspaceId, email: "p2@company2.com" },
        { workspaceId: u.workspaceId, email: "p5@company5.com" },
      ]);
      const b = await workbook(u);
      const s = sheet(u, people(3));
      await imported(u, b.id, s);
      expect((await stored(b.id)).map((r) => r.suppressed)).toEqual([false, true, false]);
      s.set(people(5));
      await pulled(u, b.id);
      const rows = await stored(b.id);
      expect(rows.map((r) => r.suppressed)).toEqual([false, true, false, false, true]);
      expect(rows[4]!.from).toMatchObject({ type: "google_sheets" });
    });
  });
});
