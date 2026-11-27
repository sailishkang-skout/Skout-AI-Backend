import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { invalidateWorkspaceAccess } from "@skout/auth";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { withFailingCellInserts } from "../test/failing-cell-inserts.js";
import { FakeHubSpot } from "../test/fake-hubspot.js";
import { importStorage } from "../services/workbook-import-storage.js";
import { failedMessage, runImportJob } from "../services/workbook-import-runner.js";
import { crmAccess } from "../services/workbook-crm-access.js";
import { saveHubSpotTokens } from "../services/crm-export.runner.js";
import { createHubSpotCredentialsStore } from "../services/hubspot-credentials.store.js";
import { buildHubSpotAuthorizeUrl, resetHubSpotRateLimitState } from "../services/hubspot.client.js";
import { getCrmConnector } from "../services/crm-connector.registry.js";

/**
 * WB2-023: importing HubSpot contacts and companies, through the real routes against a real database. HubSpot is the
 * stand-in in `test/fake-hubspot.ts`; Redis is replaced by a recorder, and background jobs are run here by calling what
 * the worker calls.
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
const {
  workbooks, workbookColumns, workbookRows, workbookCells, workbookRuns, workbookImports, entitlements, auditLogs, crmConnections,
  enrichmentJobs, enrichmentResults, creditBalances, creditTransactions, asyncJobs,
} = schema;

interface ImportBody {
  id: string;
  sourceType: string;
  sourceName: string | null;
  crm: { provider: string; object: string } | null;
  fileName: string;
  status: string;
  background: boolean;
  progress: number;
  truncated: { matched: number; considered: number } | null;
  counts: { total: number; processed: number; imported: number; duplicates: number; skipped: number; failed: number };
  error: { code: string; message: string } | null;
  report: { available: boolean; rows: number };
  preview: { headers: Array<{ index: number; name: string; fits: string[]; filled: number }>; rows: Array<{ line: number; values: string[] }>; suggestions: Array<{ header: number; target: any }> } | null;
}

describe.skipIf(!hasDatabase)("Workbooks V2 CRM import", () => {
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
    HUBSPOT_CLIENT_ID: "client-id",
    HUBSPOT_CLIENT_SECRET: "client-secret",
    CRM_CREDENTIALS_BACKEND: "inline" as const,
    CRM_CREDENTIALS_LOCAL: false,
    INTEGRATION_ENCRYPTION_KEY: "test-integration-key-0123456789",
  };
  const hubspot = new FakeHubSpot();
  const previousDir = process.env.WORKBOOK_IMPORTS_LOCAL_DIR;
  let dir: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let n = 0;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "wb2-crm-test-"));
    process.env.WORKBOOK_IMPORTS_LOCAL_DIR = dir;
    app = await buildApp(config);
  });
  beforeEach(() => {
    queue.ready = true;
    queue.jobs.length = 0;
    hubspot.reset();
    resetHubSpotRateLimitState();
    vi.stubGlobal("fetch", (input: any, init?: RequestInit) => (String(input?.url ?? input).startsWith("https://api.hubapi.com") ? hubspot.fetch(input, init) : realFetch(input, init)));
  });
  afterAll(async () => {
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
    token: string;
    headers: Record<string, string>;
  }

  async function person(): Promise<User> {
    n += 1;
    const email = `wb2-crm-${suffix}-${n}@test.com`;
    const ip = `18.${Math.floor(n / 250)}.${n % 250}.7`;
    await app.inject({ method: "GET", url: "/api/v1/me", headers: { "x-stub-user-email": email }, remoteAddress: ip });
    const [u] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
    const [m] = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, u!.id));
    await db.update(schema.workspaces).set({ accessStatus: "active" }).where(eq(schema.workspaces.id, m!.workspaceId));
    await setEntitlement(m!.workspaceId, "feature.workbooks_v2", true);
    return { userId: u!.id, workspaceId: m!.workspaceId, ip, token: `token-${suffix}-${n}`, headers: { "x-stub-user-email": email } };
  }

  /** A workspace owner with HubSpot connected. */
  async function user(options: { expiresIn?: number; portal?: string } = {}): Promise<User> {
    const u = await person();
    await connect(u, options);
    return u;
  }

  async function connect(u: User, { expiresIn = 3_600_000, portal = hubspot.portalId }: { expiresIn?: number; portal?: string } = {}) {
    hubspot.tokens.add(u.token);
    await saveHubSpotTokens(db, createHubSpotCredentialsStore(config), u.workspaceId, { accessToken: u.token, refreshToken: "refresh-1", expiresAt: new Date(Date.now() + expiresIn).toISOString() }, portal);
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
    const key = `crm-${suffix}-${++n}`;
    const [role] = await db.insert(schema.roles).values({ workspaceId: owner.workspaceId, key, name: key, description: "test", isSystem: false }).returning();
    if (permissions.length) await db.insert(schema.rolePermissions).values(permissions.map((permissionKey) => ({ roleId: role!.id, permissionKey })));
    await db.insert(schema.workspaceMemberRoles).values({ workspaceId: owner.workspaceId, userId: other.userId, roleId: role!.id });
    return { ...other, workspaceId: owner.workspaceId, headers: { ...other.headers, "x-workspace-id": owner.workspaceId } };
  }

  type Method = "GET" | "POST" | "PATCH" | "DELETE";
  const call = (u: User, method: Method, p: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method,
      url: `${URL_BASE}${p}`,
      remoteAddress: u.ip,
      headers: { ...u.headers, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });

  async function workbook(u: User, columns: Array<{ name: string; type?: "input" | "enrichment" | "formula" | "ai" | "action"; dataType?: string }> = []) {
    const res = await call(u, "POST", "", { name: "CRM" });
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

  // ── CRM records ────────────────────────────────────────────────────────────

  const contacts = (count: number, first = 1_001) =>
    hubspot.add("contacts", count, (i) => ({
      firstname: `First${first + i}`,
      lastname: `Last${first + i}`,
      email: `person${first + i}@example.com`,
      jobtitle: i % 2 ? "Engineer" : "Director",
      company: "Acme",
      phone: "+44 20 7946 0958",
      website: "https://acme.example.com",
      score: String(i),
      signed_up: "2026-03-01",
      createdate: "2026-03-01T15:30:00Z",
      subscribed: i % 2 ? "true" : "false",
      lifecyclestage: "lead",
    }), first);
  const companies = (count: number, first = 9_001) =>
    hubspot.add("companies", count, (i) => ({
      name: `Company ${first + i}`,
      domain: `company${first + i}.com`,
      website: `https://company${first + i}.com`,
      industry: "SOFTWARE",
      city: "Leeds",
      country: "UK",
      numberofemployees: String(10 + i),
    }), first);

  const CONTACT_FIELDS = ["firstname", "email", "score"];
  const preview = (u: User, workbookId: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    call(u, "POST", `/${workbookId}/crm-imports`, { provider: "hubspot", object: "contact", fields: CONTACT_FIELDS, ...body }, headers);
  async function previewed(u: User, workbookId: string, body: Record<string, unknown> = {}): Promise<ImportBody> {
    const res = await preview(u, workbookId, body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json().data;
  }
  /** The mapping suggested by the preview, as a confirm body. */
  const suggested = (item: ImportBody, dedupe: Record<string, unknown> = { key: "none" }) => ({
    columns: item.preview!.suggestions.flatMap((s) => (s.target ? [{ header: s.header, ...s.target }] : [])),
    dedupe,
  });
  const confirm = (u: User, workbookId: string, importId: string, body: unknown) => call(u, "POST", `/${workbookId}/imports/${importId}/confirm`, body);
  /** Preview, accept the suggestions, and run in the background if it has to. */
  async function imported(u: User, workbookId: string, body: Record<string, unknown> = {}, dedupe?: Record<string, unknown>): Promise<ImportBody> {
    const item = await previewed(u, workbookId, body);
    const columns = (await db.select().from(workbookColumns).where(eq(workbookColumns.workbookId, workbookId))).map((c) => c.name);
    const mapping = suggested(item, dedupe);
    // Columns made by an earlier import are mapped to, not made again.
    const existing = await db.select().from(workbookColumns).where(eq(workbookColumns.workbookId, workbookId));
    mapping.columns = mapping.columns.map((c: any) => {
      const same = c.newColumn && columns.includes(c.newColumn.name) ? existing.find((e) => e.name === c.newColumn.name) : undefined;
      return same ? { header: c.header, columnId: same.id } : c;
    });
    const res = await confirm(u, workbookId, item.id, mapping);
    expect([200, 202], res.body).toContain(res.statusCode);
    if (res.statusCode === 202) await work(item.id);
    return status(u, workbookId, item.id);
  }
  async function status(u: User, workbookId: string, importId: string): Promise<ImportBody> {
    const res = await call(u, "GET", `/${workbookId}/imports/${importId}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data;
  }
  const storage = () => importStorage(config)!;
  const work = (importId: string, lastAttempt = false) => runImportJob(db, storage(), importId, lastAttempt, undefined, crmAccess(db, config));
  const report = async (u: User, workbookId: string, importId: string) =>
    (await call(u, "GET", `/${workbookId}/imports/${importId}/report`)).body.replace(/^\uFEFF/, "").trimEnd().split("\r\n");

  async function stored(workbookId: string) {
    const columns = await db.select().from(workbookColumns).where(eq(workbookColumns.workbookId, workbookId));
    const name = new Map(columns.map((c) => [c.id, c.name]));
    const rows = await db.select().from(workbookRows).where(eq(workbookRows.workbookId, workbookId)).orderBy(asc(workbookRows.position));
    const cells = await db.select().from(workbookCells).where(eq(workbookCells.workbookId, workbookId));
    const byRow = new Map<number, Record<string, unknown>>();
    for (const c of cells) byRow.set(c.rowId, { ...byRow.get(c.rowId), [name.get(c.columnId)!]: c.value });
    return rows.map((r) => ({ ...r, ref: r.crmRef as Record<string, string>, values: byRow.get(r.id) ?? {} }));
  }
  const refIds = async (workbookId: string) => (await stored(workbookId)).map((r) => r.ref.id);
  const rowCount = async (workbookId: string) => (await db.select({ n: workbooks.rowCount }).from(workbooks).where(eq(workbooks.id, workbookId)))[0]!.n;
  const events = async (workbookId: string) =>
    (await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, workbookId), eq(auditLogs.action, "workbook.rows.added"))).orderBy(asc(auditLogs.createdAt))).map((e) => e.afterState);
  const connection = async (u: User) => (await db.select().from(crmConnections).where(eq(crmConnections.workspaceId, u.workspaceId)))[0]!;
  const refused = async (res: ReturnType<typeof call>, httpStatus: number, code: string) => {
    const answer = await res;
    expect(answer.statusCode, answer.body).toBe(httpStatus);
    expect(answer.json().code).toBe(code);
    expect(answer.body).not.toMatch(/secret detail|token-|refresh-1|client-secret/);
    return answer.json();
  };
  const pages = (type: "contacts" | "companies") => hubspot.calls.filter((c) => c.method === "GET" && c.path === `/crm/v3/objects/${type}`);

  // ── Choosing a CRM, an object and a selection ──────────────────────────────

  describe("sources", () => {
    it("says which CRMs can be imported from and how each connection stands", async () => {
      const u = await user();
      const other = await person();
      const b = await workbook(u);
      const mine = await call(u, "GET", `/${b.id}/crm-sources`);
      expect(mine.statusCode, mine.body).toBe(200);
      expect(mine.json().data).toEqual([
        { provider: "hubspot", label: "HubSpot", status: "connected", objects: ["contact", "company"] },
        { provider: "salesforce", label: "Salesforce", status: "not_available", objects: [] },
        { provider: "pipedrive", label: "Pipedrive", status: "not_available", objects: [] },
      ]);
      expect(mine.body).not.toContain(u.token);
      const theirs = await workbook(other);
      const hubspotOf = async () => (await call(other, "GET", `/${theirs.id}/crm-sources`)).json().data[0].status;
      expect(await hubspotOf()).toBe("not_connected");
      await connect(other);
      await db.update(crmConnections).set({ status: "needs_reauth" }).where(eq(crmConnections.workspaceId, other.workspaceId));
      expect(await hubspotOf()).toBe("needs_reauth");
    });

    it("says when HubSpot isn't set up on the server", async () => {
      const u = await person();
      const b = await workbook(u);
      const bare = await buildApp({ ...config, HUBSPOT_CLIENT_ID: undefined });
      const res = await bare.inject({ method: "GET", url: `${URL_BASE}/${b.id}/crm-sources`, headers: u.headers, remoteAddress: u.ip });
      expect(res.json().data[0].status).toBe("not_configured");
      await bare.close();
    });

    it.each([
      ["contact", "firstname", "Pipeline"],
      ["company", "name", "Accounts"],
    ])("describes %s fields, their filters and the lists of that kind", async (object, first, listName) => {
      const u = await user();
      const b = await workbook(u);
      hubspot.lists = [
        { listId: "11", name: "Pipeline", objectType: "contacts", members: ["1"] },
        { listId: "22", name: "Accounts", objectType: "companies", members: ["2", "3"] },
      ];
      const res = await call(u, "GET", `/${b.id}/crm-sources/hubspot/${object}`);
      expect(res.statusCode, res.body).toBe(200);
      const data = res.json().data;
      expect(data.defaultFields).toContain(first);
      expect(data.fields.map((f: any) => f.name)).not.toContain("hs_internal");
      expect(data.views).toMatchObject({ label: "HubSpot list", available: true, reason: null, items: [{ name: listName }] });
      expect(data.views.note).toContain("saved views can't be read");
      expect(data.filters).toEqual({ max: 5 });
      const operators = Object.fromEntries(data.fields.map((f: any) => [f.type, f.operators]));
      expect(operators.string).toContain("contains");
      expect(operators.number).toEqual(expect.arrayContaining(["greater_than", "at_most"]));
      expect(operators.number).not.toContain("contains");
      expect(res.body).not.toContain(u.token);
    });

    it("reads every page of lists", async () => {
      const u = await user();
      const b = await workbook(u);
      hubspot.lists = Array.from({ length: 600 }, (_, i) => ({ listId: String(i + 1), name: `List ${i + 1}`, objectType: "contacts" as const, members: [] }));
      expect((await call(u, "GET", `/${b.id}/crm-sources/hubspot/contact`)).json().data.views.items).toHaveLength(600);
    });

    it("still offers everything and filters when the connection may not read lists", async () => {
      const u = await user();
      const b = await workbook(u);
      contacts(3);
      hubspot.scopes.delete("crm.lists.read");
      const data = (await call(u, "GET", `/${b.id}/crm-sources/hubspot/contact`)).json().data;
      expect(data.views).toMatchObject({ available: false, items: [] });
      expect(data.views.reason).toContain("Reconnect HubSpot");
      expect((await imported(u, b.id)).counts.imported).toBe(3);
      await refused(preview(u, b.id, { viewId: "11" }), 409, "CRM_SCOPE_MISSING");
    });

    it("asks to reconnect when HubSpot hasn't granted access to companies", async () => {
      const u = await user();
      const b = await workbook(u);
      companies(2);
      hubspot.scopes.delete("crm.objects.companies.read");
      hubspot.scopes.delete("crm.schemas.companies.read");
      const answer = await refused(call(u, "GET", `/${b.id}/crm-sources/hubspot/company`), 409, "CRM_SCOPE_MISSING");
      expect(answer.message).toContain("Reconnect HubSpot");
      await refused(preview(u, b.id, { object: "company", fields: ["name"] }), 409, "CRM_SCOPE_MISSING");
      expect((await connection(u)).status).toBe("connected");
    });

    it("asks for permission to read companies only once the HubSpot app offers it", () => {
      const params = { clientId: "c", redirectUri: "https://x.test/cb", state: "s" };
      expect(new URL(buildHubSpotAuthorizeUrl(params)).searchParams.get("optional_scope")).toBeNull();
      const url = new URL(buildHubSpotAuthorizeUrl({ ...params, companyScopes: true }));
      expect(url.searchParams.get("optional_scope")).toBe("crm.objects.companies.read crm.schemas.companies.read");
      expect(url.searchParams.get("scope")).not.toContain("companies");
    });

    it.each(["salesforce", "pipedrive"])("offers nothing from %s, which has no connector", async (provider) => {
      const u = await user();
      const b = await workbook(u);
      const answer = await refused(call(u, "GET", `/${b.id}/crm-sources/${provider}/contact`), 422, "CRM_NOT_AVAILABLE");
      expect(answer.message).toContain("isn't available yet");
      await refused(preview(u, b.id, { provider }), 422, "CRM_NOT_AVAILABLE");
      expect(hubspot.calls).toEqual([]);
    });

    it("explains a CRM that is not connected, and never reads another workspace's", async () => {
      await user();
      const u = await person();
      const b = await workbook(u);
      for (const res of [call(u, "GET", `/${b.id}/crm-sources/hubspot/contact`), preview(u, b.id)]) {
        const answer = await refused(res, 409, "CRM_NOT_CONNECTED");
        expect(answer.message).toContain("Connect it in Settings");
      }
      expect(hubspot.calls).toEqual([]);
    });

    it("refreshes an expired token by itself", async () => {
      const u = await user({ expiresIn: -1_000 });
      const b = await workbook(u);
      contacts(2);
      hubspot.refresh.issues = `${u.token}-new`;
      expect((await imported(u, b.id)).counts.imported).toBe(2);
      expect(hubspot.calls.filter((c) => c.path === "/oauth/v1/token")).toHaveLength(1);
      expect(hubspot.calls.filter((c) => c.path.startsWith("/crm/")).every((c) => c.token === `${u.token}-new`)).toBe(true);
    });

    it.each([
      ["revoked at refresh", { expiresIn: -1_000 }, () => (hubspot.refresh.revoked = true)],
      ["rejected by the API", {}, (u: User) => hubspot.tokens.delete(u.token)],
    ])("asks to reconnect when access is %s, and notes it on the connection", async (_name, options, breakIt) => {
      const u = await user(options);
      const b = await workbook(u);
      (breakIt as (u: User) => void)(u);
      const answer = await refused(preview(u, b.id), 409, "CRM_RECONNECT_REQUIRED");
      expect(answer.message).toContain("Reconnect HubSpot");
      expect((await connection(u)).status).toBe("needs_reauth");
      await refused(preview(u, b.id), 409, "CRM_RECONNECT_REQUIRED");
    });

    it("notes the connection when a read is refused after the token looked fine", async () => {
      const u = await user();
      const b = await workbook(u);
      contacts(2);
      hubspot.fail((c) => c.path === "/crm/v3/properties/contacts", 401);
      await refused(call(u, "GET", `/${b.id}/crm-sources/hubspot/contact`), 409, "CRM_RECONNECT_REQUIRED");
      expect((await connection(u)).status).toBe("needs_reauth");
    });

    it.each([
      [429, { "retry-after": "120" }, 429, "CRM_RATE_LIMITED"],
      [500, {}, 502, "CRM_UNAVAILABLE"],
      [400, {}, 422, "CRM_QUERY_REJECTED"],
    ])("turns a %i from HubSpot into an answer without HubSpot's words", async (hubspotStatus, headers, httpStatus, code) => {
      const u = await user();
      const b = await workbook(u);
      contacts(2);
      hubspot.fail((c) => c.path === "/crm/v3/properties/contacts", hubspotStatus, { times: 10, headers });
      await refused(preview(u, b.id), httpStatus, code);
      expect(await db.select().from(workbookImports).where(eq(workbookImports.workbookId, b.id))).toEqual([]);
    });
  });

  // ── Preview ────────────────────────────────────────────────────────────────

  describe("preview", () => {
    it("reads the first records of the chosen fields, suggests columns, and adds nothing", async () => {
      const u = await user();
      const b = await workbook(u, [{ name: "Email", dataType: "email" }]);
      contacts(45);
      const item = await previewed(u, b.id, { fields: ["firstname", "email", "score", "signed_up", "createdate", "subscribed", "phone", "website"] });
      expect(item).toMatchObject({ sourceType: "hubspot", crm: { provider: "hubspot", object: "contact" }, status: "awaiting_confirmation", fileName: "HubSpot contacts", counts: { total: 45 } });
      expect(item.preview!.headers.map((h) => h.name)).toEqual(["First name", "Email", "Lead score", "Signed up", "Create date", "Subscribed", "Phone number", "Website URL"]);
      expect(item.preview!.rows).toHaveLength(20);
      expect(item.preview!.rows[0]!.values[1]).toBe("person1001@example.com");
      const targets = item.preview!.suggestions.map((s) => s.target);
      expect(targets[1]).toEqual({ columnId: b.col.Email });
      expect(targets.map((t) => t?.newColumn?.dataType ?? "existing")).toEqual(["text", "existing", "number", "date", "date", "checkbox", "phone", "url"]);
      expect(await stored(b.id)).toEqual([]);
      expect(await db.select().from(workbookColumns).where(eq(workbookColumns.workbookId, b.id))).toHaveLength(1);
      const asked = pages("contacts")[0]!.query;
      expect(asked.properties!.split(",")).toEqual(["firstname", "email", "score", "signed_up", "createdate", "subscribed", "phone", "website"]);
      expect(asked.limit).toBe("20");
    });

    it("offers a field's own type and text, and keeps numbers-as-text as text", async () => {
      const u = await user();
      const b = await workbook(u);
      hubspot.add("contacts", 3, () => ({ company: "00123", score: "7", email: "not an email" }));
      const item = await previewed(u, b.id, { fields: ["company", "score", "email"] });
      const [company, score, email] = item.preview!.headers;
      expect(company!.fits).toEqual(expect.arrayContaining(["text", "number"]));
      expect(score!.fits).toEqual(["text", "number"]);
      expect(email!.fits).toEqual(["text", "email"]);
      expect(item.preview!.suggestions.map((s) => s.target.newColumn.dataType)).toEqual(["text", "number", "text"]);
    });

    it("takes a list of either kind, and names it", async () => {
      const u = await user();
      const b = await workbook(u);
      const ids = companies(4);
      hubspot.lists = [{ listId: "22", name: "Key accounts", objectType: "companies", members: [ids[2]!, ids[0]!] }];
      const item = await previewed(u, b.id, { object: "company", fields: ["name"], viewId: "22" });
      expect(item).toMatchObject({ sourceName: "Key accounts", fileName: "HubSpot companies · Key accounts", counts: { total: 2 } });
      expect(item.preview!.rows.map((r) => r.values)).toEqual([["Company 9003"], ["Company 9001"]]);
      await refused(preview(u, b.id, { viewId: "22" }), 422, "CRM_UNKNOWN_VIEW");
      await refused(preview(u, b.id, { object: "company", fields: ["name"], viewId: "99" }), 422, "CRM_UNKNOWN_VIEW");
    });

    it.each([
      ["an unknown field", { fields: ["firstname", "nope"] }, "CRM_UNKNOWN_FIELD"],
      ["a hidden field", { fields: ["hs_internal"] }, "CRM_UNKNOWN_FIELD"],
      ["a filter on an unknown field", { filters: [{ field: "nope", operator: "equals", value: "x" }] }, "CRM_INVALID_FILTER"],
      ["an operator the field doesn't have", { filters: [{ field: "score", operator: "contains", value: "1" }] }, "CRM_INVALID_FILTER"],
      ["a number filter with words", { filters: [{ field: "score", operator: "equals", value: "many" }] }, "CRM_INVALID_FILTER"],
      ["a date filter with words", { filters: [{ field: "signed_up", operator: "at_least", value: "last week" }] }, "CRM_INVALID_FILTER"],
      ["a missing value", { filters: [{ field: "email", operator: "equals" }] }, "CRM_INVALID_FILTER"],
      ["a value where none is wanted", { filters: [{ field: "email", operator: "has_value", value: "x" }] }, "CRM_INVALID_FILTER"],
      ["more filters than HubSpot takes", { filters: Array.from({ length: 6 }, () => ({ field: "email", operator: "has_value" })) }, "CRM_INVALID_FILTER"],
      ["a list and filters together", { viewId: "11", filters: [{ field: "email", operator: "has_value" }] }, "CRM_INVALID_FILTER"],
    ])("refuses %s before reading any record", async (_name, body, code) => {
      const u = await user();
      const b = await workbook(u);
      contacts(3);
      await refused(preview(u, b.id, body), 422, code);
      expect(hubspot.calls.filter((c) => c.path.startsWith("/crm/v3/objects"))).toEqual([]);
      expect(await db.select().from(workbookImports).where(eq(workbookImports.workbookId, b.id))).toEqual([]);
    });

    it("refuses a malformed request", async () => {
      const u = await user();
      const b = await workbook(u);
      const bodies = [
        { fields: [] },
        { fields: ["email", "email"] },
        { fields: Array.from({ length: 51 }, (_, i) => `f${i}`) },
        { provider: "zoho" },
        { object: "deal" },
        { connectionId: randomUUID() },
        { accountId: "999" },
        { viewId: "../../oauth" },
        { filters: [{ field: "email", operator: "LIKE", value: "x" }] },
      ];
      for (const body of bodies) await refused(preview(u, b.id, body), 422, "VALIDATION_FAILED");
      expect(hubspot.calls).toEqual([]);
    });

    it("says when there is nothing to import", async () => {
      const u = await user();
      const b = await workbook(u);
      await refused(preview(u, b.id), 422, "NOTHING_TO_ADD");
      contacts(1);
      await refused(preview(u, b.id, { filters: [{ field: "email", operator: "equals", value: "nobody@x.com" }] }), 422, "NOTHING_TO_ADD");
    });

    it("makes one preview for a repeated request", async () => {
      const u = await user();
      const b = await workbook(u);
      contacts(2);
      const key = { "idempotency-key": randomUUID() };
      const [first, again] = [await preview(u, b.id, {}, key), await preview(u, b.id, {}, key)];
      expect(again.json()).toEqual(first.json());
      expect(await db.select().from(workbookImports).where(eq(workbookImports.workbookId, b.id))).toHaveLength(1);
    });
  });

  // ── Importing ──────────────────────────────────────────────────────────────

  describe.each([
    ["contact", "contacts", ["firstname", "email"], "person1001@example.com"],
    ["company", "companies", ["name", "domain"], "company9001.com"],
  ] as const)("importing %s records", (object, type, fields, sample) => {
    const seed = (count: number) => (object === "contact" ? contacts(count) : companies(count));

    it("adds every record with its reference, source and one activity entry", async () => {
      const u = await user();
      const b = await workbook(u);
      const ids = seed(30);
      const done = await imported(u, b.id, { object, fields: [...fields] });
      expect(done).toMatchObject({ status: "completed", progress: 100, error: null, counts: { total: 30, processed: 30, imported: 30, duplicates: 0, skipped: 0, failed: 0 }, report: { rows: 0 } });
      const rows = await stored(b.id);
      expect(rows.map((r) => r.ref)).toEqual(ids.map((id) => ({ provider: "hubspot", object, id, accountId: "1234567" })));
      expect(rows[0]!.source).toMatchObject({ type: "hubspot", object, importId: done.id });
      expect(Object.values(rows[0]!.values)).toContain(sample);
      expect(rows[0]!.prospectId).toBeNull();
      expect(await rowCount(b.id)).toBe(30);
      expect(await events(b.id)).toEqual([{ source: "hubspot", object, rows: 30, rowCount: 30 }]);
    });

    it("adds a list in its order, and reports records it no longer has", async () => {
      const u = await user();
      const b = await workbook(u);
      const ids = seed(250);
      const members = [...ids].reverse();
      members.splice(3, 0, "42");
      hubspot.lists = [{ listId: "7", name: "Chosen", objectType: type, members }];
      const done = await imported(u, b.id, { object, fields: [...fields], viewId: "7" });
      expect(done.counts).toMatchObject({ processed: 251, imported: 250, skipped: 1 });
      expect(await refIds(b.id)).toEqual([...ids].reverse());
      expect((await stored(b.id))[0]!.source).toMatchObject({ viewId: "7", viewName: "Chosen" });
      expect(await events(b.id)).toEqual([{ source: "hubspot", object, viewName: "Chosen", rows: 250, rowCount: 250 }]);
      const lines = await report(u, b.id, done.id);
      expect(lines[0]).toContain("CRM record ID");
      expect(lines[1]).toBe('"4","Skipped","No longer in HubSpot","42"');
    });

    it("runs more than 1,000 records in the background, page by page", async () => {
      const u = await user();
      const b = await workbook(u);
      const ids = seed(2_350);
      const item = await previewed(u, b.id, { object, fields: [...fields] });
      const res = await confirm(u, b.id, item.id, suggested(item));
      expect(res.statusCode, res.body).toBe(202);
      expect(res.json().data).toMatchObject({ status: "queued", background: true, progress: 0 });
      expect(queue.jobs).toEqual([{ importId: item.id, workspaceId: u.workspaceId }]);
      expect(await rowCount(b.id)).toBe(0);
      hubspot.calls.length = 0;
      await work(item.id);
      await work(item.id);
      expect(await status(u, b.id, item.id)).toMatchObject({ status: "completed", counts: { total: 2_350, imported: 2_350, duplicates: 0 } });
      expect(await refIds(b.id)).toEqual(ids);
      expect(pages(type)).toHaveLength(24);
      expect(pages(type).every((c) => c.query.limit === "100")).toBe(true);
    });
  });

  it("walks filtered results past HubSpot's first 10,000 by record id", async () => {
    const u = await user();
    const b = await workbook(u);
    contacts(10_450);
    const done = await imported(u, b.id, { fields: ["email"], filters: [{ field: "email", operator: "contains", value: "@example.com" }] });
    expect(done.counts).toMatchObject({ total: 10_450, imported: 10_450 });
    expect(new Set(await refIds(b.id)).size).toBe(10_450);
    expect((await stored(b.id))[0]!.source).toMatchObject({ filtered: true });
    const searches = hubspot.calls.filter((c) => c.path.endsWith("/search") && c.body.limit === 100);
    expect(searches.length).toBe(105);
    expect(searches[0]!.body.filterGroups[0].filters).toHaveLength(1);
    expect(searches[1]!.body.filterGroups[0].filters[1]).toEqual({ propertyName: "hs_object_id", operator: "GT", value: "1100" });
    expect(searches.every((c) => !("after" in c.body))).toBe(true);
  }, 120_000);

  it.each([
    [[{ field: "jobtitle", operator: "equals", value: "Director" }], ["1001", "1003", "1005"]],
    [[{ field: "score", operator: "greater_than", value: "3" }], ["1005", "1006"]],
    [[{ field: "score", operator: "at_most", value: "1" }, { field: "subscribed", operator: "equals", value: "yes" }], ["1002"]],
    [[{ field: "signed_up", operator: "at_least", value: "2026-03-01" }, { field: "firstname", operator: "not_contains", value: "First1001" }], ["1002", "1003", "1004", "1005", "1006"]],
    // A day covers its whole length for a date with a time.
    [[{ field: "createdate", operator: "at_most", value: "2026-03-01" }], ["1001", "1002", "1003", "1004", "1005", "1006"]],
    [[{ field: "createdate", operator: "less_than", value: "2026-03-02" }, { field: "createdate", operator: "greater_than", value: "2026-02-28" }], ["1001", "1002", "1003", "1004", "1005", "1006"]],
    [[{ field: "website", operator: "has_value" }, { field: "lifecyclestage", operator: "not_equals", value: "customer" }], ["1001", "1002", "1003", "1004", "1005", "1006"]],
  ])("imports exactly what the filters %j select", async (filters, ids) => {
    const u = await user();
    const b = await workbook(u);
    contacts(6);
    await imported(u, b.id, { filters });
    expect(await refIds(b.id)).toEqual(ids);
  });

  it("finds nothing for a date filter that excludes the whole day", async () => {
    const u = await user();
    const b = await workbook(u);
    contacts(2);
    await refused(preview(u, b.id, { filters: [{ field: "createdate", operator: "greater_than", value: "2026-03-01" }] }), 422, "NOTHING_TO_ADD");
  });

  // ── Duplicates ─────────────────────────────────────────────────────────────

  it("never adds the same record twice, and adds only what is new", async () => {
    const u = await user();
    const b = await workbook(u);
    const ids = contacts(5);
    hubspot.lists = [{ listId: "7", name: "Two", objectType: "contacts", members: ids.slice(0, 2) }];
    expect((await imported(u, b.id, { viewId: "7" })).counts.imported).toBe(2);
    const all = await imported(u, b.id);
    expect(all.counts).toMatchObject({ imported: 3, duplicates: 2 });
    const again = await imported(u, b.id);
    expect(again.counts).toMatchObject({ imported: 0, duplicates: 5 });
    expect(again.status).toBe("completed");
    expect(await refIds(b.id)).toEqual(ids);
    expect(await events(b.id)).toHaveLength(2);
    expect((await report(u, b.id, again.id))[1]).toContain('"Duplicate","This record is already in the workbook","1001"');
    // A deleted row can come back.
    const [first] = await stored(b.id);
    expect((await call(u, "DELETE", `/${b.id}/rows/${first!.id}`)).statusCode).toBe(200);
    expect((await imported(u, b.id)).counts).toMatchObject({ imported: 1, duplicates: 4 });
  });

  it("keeps a contact and a company with the same id, and the same id from another account, apart", async () => {
    const u = await user();
    const b = await workbook(u);
    contacts(1, 500);
    companies(1, 500);
    await imported(u, b.id);
    await imported(u, b.id, { object: "company", fields: ["name"] });
    hubspot.portalId = "999";
    u.token = `${u.token}-other`;
    await connect(u, { portal: "999" });
    await imported(u, b.id);
    expect((await stored(b.id)).map((r) => [r.ref.object, r.ref.id, r.ref.accountId])).toEqual([["contact", "500", "1234567"], ["company", "500", "1234567"], ["contact", "500", "999"]]);
  });

  it("adds a record once when the CRM hands it over twice", async () => {
    const u = await user();
    const b = await workbook(u);
    const ids = contacts(3);
    hubspot.lists = [{ listId: "7", name: "Repeats", objectType: "contacts", members: [ids[0]!, ids[1]!, ids[0]!, ids[2]!] }];
    expect((await imported(u, b.id, { viewId: "7" })).counts).toMatchObject({ imported: 3, duplicates: 1 });
  });

  it("applies the chosen duplicate key as well, against rows already there", async () => {
    const u = await user();
    const b = await workbook(u, [{ name: "Email", dataType: "email" }]);
    contacts(3);
    await call(u, "POST", `/${b.id}/rows`, { cells: { [b.col.Email!]: "PERSON1002@example.com" } });
    const done = await imported(u, b.id, { fields: ["email"] }, { key: "email" });
    expect(done.counts).toMatchObject({ imported: 2, duplicates: 1 });
  });

  it("keeps the references through a workbook copy, and does not add them again to the copy", async () => {
    const u = await user();
    const b = await workbook(u);
    contacts(3);
    await imported(u, b.id);
    const copy = (await call(u, "POST", `/${b.id}/duplicate`, { includeRows: true })).json().data.id as string;
    expect((await stored(copy)).map((r) => r.ref)).toEqual((await stored(b.id)).map((r) => r.ref));
    expect((await imported(u, copy)).counts).toMatchObject({ imported: 0, duplicates: 3 });
  });

  // ── Mapping ────────────────────────────────────────────────────────────────

  it("imports into chosen existing columns, reporting values that don't fit with the record's id", async () => {
    const u = await user();
    const b = await workbook(u, [{ name: "Who" }, { name: "Mail", dataType: "email" }]);
    contacts(3);
    hubspot.records.contacts[1]!.properties.email = "broken";
    const item = await previewed(u, b.id, { fields: ["firstname", "email"] });
    // A broken value in the preview doesn't stop the field going into an email column.
    const res = await confirm(u, b.id, item.id, { columns: [{ header: 0, columnId: b.col.Who }, { header: 1, columnId: b.col.Mail }], dedupe: { key: "none" } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.counts).toMatchObject({ imported: 2, failed: 1 });
    expect((await stored(b.id)).map((r) => r.values)).toEqual([{ Who: "First1001", Mail: "person1001@example.com" }, { Who: "First1003", Mail: "person1003@example.com" }]);
    expect((await report(u, b.id, item.id))[1]).toBe('"2","Invalid value","Invalid field value. Mail: not a valid email address","1002","First1002","broken"');
  });

  it("refuses a column that cannot hold the field, and changes nothing", async () => {
    const u = await user();
    const b = await workbook(u, [{ name: "Count", dataType: "number" }, { name: "Found", type: "enrichment" }]);
    contacts(2);
    const item = await previewed(u, b.id);
    for (const columns of [
      [{ header: 0, columnId: b.col.Count }],
      [{ header: 1, newColumn: { name: "When", dataType: "date" } }],
      [{ header: 2, newColumn: { name: "Mail", dataType: "email" } }],
    ]) {
      const answer = await refused(confirm(u, b.id, item.id, { columns, dedupe: { key: "none" } }), 422, "INVALID_IMPORT_MAPPING");
      expect(answer.details.errors[0].code).toBe("INCOMPATIBLE_FIELD");
    }
    await refused(confirm(u, b.id, item.id, { columns: [{ header: 0, columnId: b.col.Found }], dedupe: { key: "none" } }), 422, "INVALID_IMPORT_MAPPING");
    expect(await db.select().from(workbookColumns).where(eq(workbookColumns.workbookId, b.id))).toHaveLength(2);
    expect(await status(u, b.id, item.id)).toMatchObject({ status: "awaiting_confirmation" });
  });

  it("can be cancelled before it is confirmed", async () => {
    const u = await user();
    const b = await workbook(u);
    contacts(2);
    const item = await previewed(u, b.id);
    expect((await call(u, "DELETE", `/${b.id}/imports/${item.id}`)).json().data.status).toBe("cancelled");
    await refused(confirm(u, b.id, item.id, suggested(item)), 409, "IMPORT_STATE_CONFLICT");
    expect(await stored(b.id)).toEqual([]);
  });

  // ── Row limit ──────────────────────────────────────────────────────────────

  it("fills the workbook to its limit, reports the rest, and stops reading", async () => {
    const u = await user();
    await setEntitlement(u.workspaceId, "workbooks.row_limit", 650);
    const b = await workbook(u);
    contacts(3_000);
    const done = await imported(u, b.id);
    expect(done).toMatchObject({ status: "completed", counts: { imported: 650, processed: 1_000, total: 1_000, failed: 350 }, truncated: { matched: 3_000, considered: 1_000 } });
    expect(await rowCount(b.id)).toBe(650);
    expect(pages("contacts").length).toBeLessThanOrEqual(12);
    expect((await report(u, b.id, done.id))[1]).toContain("Over the row limit");
    const next = await previewed(u, b.id);
    await refused(confirm(u, b.id, next.id, { columns: [{ header: 0, newColumn: { name: "Other", dataType: "text" } }], dedupe: { key: "none" } }), 422, "ROW_LIMIT_EXCEEDED");
  });

  it("reports the overflow of a selection that ends inside the last chunk", async () => {
    const u = await user();
    await setEntitlement(u.workspaceId, "workbooks.row_limit", 2);
    const b = await workbook(u);
    contacts(5);
    expect(await imported(u, b.id)).toMatchObject({ counts: { imported: 2, failed: 3, processed: 5 }, truncated: null });
  });

  // ── Retries and failures ───────────────────────────────────────────────────

  /** A confirmed background import of `count` contacts, not yet run. */
  async function queued(count: number) {
    const u = await user();
    const b = await workbook(u);
    const ids = contacts(count);
    const item = await previewed(u, b.id);
    expect((await confirm(u, b.id, item.id, suggested(item))).statusCode).toBe(202);
    return { u, b, ids, id: item.id };
  }
  const pageAfter = (after: number) => (c: { path: string; query: Record<string, string> }) => c.path === "/crm/v3/objects/contacts" && c.query.after === String(after);

  it("rides out a short rate limit within the request", async () => {
    const u = await user();
    const b = await workbook(u);
    contacts(250);
    hubspot.fail(pageAfter(100), 429, { times: 2, headers: { "retry-after": "0" } });
    expect((await imported(u, b.id)).counts.imported).toBe(250);
  });

  it("carries on from where it stopped after HubSpot fails part way", async () => {
    const { u, b, ids, id } = await queued(1_600);
    hubspot.fail(pageAfter(700), 500);
    await expect(work(id)).rejects.toThrow("Try later (CRM_UNAVAILABLE)");
    expect(await status(u, b.id, id)).toMatchObject({ status: "processing", counts: { processed: 500, imported: 500 } });
    hubspot.calls.length = 0;
    await work(id);
    expect(await status(u, b.id, id)).toMatchObject({ status: "completed", counts: { processed: 1_600, imported: 1_600, duplicates: 0 } });
    expect(pages("contacts")[0]!.query.after).toBe("500");
    expect(await refIds(b.id)).toEqual(ids);
    expect(await events(b.id)).toHaveLength(1);
  });

  // Left unfinished, it is what the sweep re-queues (tested with the CSV imports: the sweep covers every kind). The
  // sweep itself isn't run here: it looks at every import in the database, including other test files' own.
  it("does not give up on a busy CRM at the last attempt", async () => {
    const { u, b, id } = await queued(1_200);
    hubspot.fail(pageAfter(600), 429, { times: 4, headers: { "retry-after": "0" } });
    await expect(work(id, true)).rejects.toThrow("Try later (CRM_RATE_LIMITED)");
    expect(await status(u, b.id, id)).toMatchObject({ status: "processing", error: null, counts: { processed: 500 } });
    await work(id);
    expect(await status(u, b.id, id)).toMatchObject({ status: "completed", counts: { imported: 1_200 } });
    // What is said if hours of trouble do end it.
    expect(failedMessage("hubspot")).toContain("Import the same selection again");
    expect(failedMessage("csv")).toContain("upload the file again");
  });

  it("moves a small import into the background when HubSpot is busy, or says so if it can't", async () => {
    const u = await user();
    const b = await workbook(u);
    contacts(5);
    const item = await previewed(u, b.id);
    hubspot.fail((c) => c.path === "/crm/v3/objects/contacts", 500);
    const res = await confirm(u, b.id, item.id, suggested(item));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.status).toBe("processing");
    expect(queue.jobs).toEqual([{ importId: item.id, workspaceId: u.workspaceId }]);
    await work(item.id);
    expect((await status(u, b.id, item.id)).counts.imported).toBe(5);

    const other = await workbook(u);
    const second = await previewed(u, other.id);
    queue.ready = false;
    hubspot.fail((c) => c.path === "/crm/v3/objects/contacts", 429, { times: 4, headers: { "retry-after": "0" } });
    const failed = (await confirm(u, other.id, second.id, suggested(second))).json().data as ImportBody;
    expect(failed).toMatchObject({ status: "failed", error: { code: "CRM_RATE_LIMITED" } });
    expect(failed.error!.message).toContain("limiting requests");
    expect(failed.error!.message).not.toContain("secret detail");
  });

  it("fails after repeated unexpected errors, keeping what it added", async () => {
    const { u, b, id } = await queued(1_200);
    await withFailingCellInserts(sql, `wb2_crm_boom_${suffix}`, `new.value = '"First1700"'::jsonb`, async () => {
      await expect(work(id)).rejects.toThrow(/could not be processed/);
      expect(await status(u, b.id, id)).toMatchObject({ status: "processing", counts: { processed: 500, imported: 500 } });
      const [record] = await db.select().from(workbookImports).where(eq(workbookImports.id, id));
      expect((record!.plan as any).crm.cursor).toBe("500");
      expect(await rowCount(b.id)).toBe(500);
      await expect(work(id, true)).rejects.toThrow();
    });
    const failed = await status(u, b.id, id);
    expect(failed).toMatchObject({ status: "failed", error: { code: "IMPORT_FAILED" }, counts: { imported: 500 } });
    expect(failed.error!.message).toContain("records already there are skipped");
    expect((await imported(u, b.id)).counts).toMatchObject({ imported: 700, duplicates: 500 });
  });

  it("stops when access is revoked part way, says what to do, and finishes the rest after reconnecting", async () => {
    const { u, b, id } = await queued(1_300);
    hubspot.onCall = (c) => {
      if (pageAfter(600)(c)) hubspot.tokens.delete(u.token);
    };
    await work(id);
    const failed = await status(u, b.id, id);
    expect(failed).toMatchObject({ status: "failed", error: { code: "CRM_RECONNECT_REQUIRED" }, counts: { imported: 500 } });
    expect(failed.error!.message).toContain("Reconnect HubSpot");
    expect((await connection(u)).status).toBe("needs_reauth");
    hubspot.onCall = null;
    u.token = `${u.token}-again`;
    await connect(u);
    expect((await imported(u, b.id)).counts).toMatchObject({ imported: 800, duplicates: 500 });
  });

  it.each([
    ["the list is deleted", "CRM_VIEW_NOT_FOUND", () => (hubspot.lists = [])],
    ["HubSpot rejects the request", "CRM_QUERY_REJECTED", () => hubspot.fail((c) => c.path.endsWith("/memberships"), 400, { times: 5 })],
    ["permission is taken away", "CRM_SCOPE_MISSING", () => hubspot.scopes.delete("crm.objects.contacts.read")],
  ])("stops when %s", async (_name, code, change) => {
    const u = await user();
    const b = await workbook(u);
    const ids = contacts(1_200);
    hubspot.lists = [{ listId: "7", name: "All", objectType: "contacts", members: ids }];
    const item = await previewed(u, b.id, { viewId: "7" });
    await confirm(u, b.id, item.id, suggested(item));
    change();
    await work(item.id);
    expect(await status(u, b.id, item.id)).toMatchObject({ status: "failed", error: { code } });
  });

  it("does not start, or go on, against a different account than the preview showed", async () => {
    const u = await user();
    const b = await workbook(u);
    contacts(1_200);
    const item = await previewed(u, b.id);
    const swap = async () => {
      u.token = `${u.token}-swapped`;
      hubspot.portalId = "999";
      await connect(u, { portal: "999" });
    };
    await swap();
    await refused(confirm(u, b.id, item.id, suggested(item)), 409, "CRM_ACCOUNT_CHANGED");
    expect(await status(u, b.id, item.id)).toMatchObject({ status: "awaiting_confirmation" });

    hubspot.portalId = "1234567";
    u.token = `${u.token}-back`;
    await connect(u);
    expect((await confirm(u, b.id, item.id, suggested(item))).statusCode).toBe(202);
    await swap();
    await work(item.id);
    expect(await status(u, b.id, item.id)).toMatchObject({ status: "failed", error: { code: "CRM_ACCOUNT_CHANGED" }, counts: { imported: 0 } });
  });

  it("refuses to confirm once the CRM is disconnected", async () => {
    const u = await user();
    const b = await workbook(u);
    contacts(2);
    const item = await previewed(u, b.id);
    await db.delete(crmConnections).where(eq(crmConnections.workspaceId, u.workspaceId));
    await refused(confirm(u, b.id, item.id, suggested(item)), 409, "CRM_NOT_CONNECTED");
  });

  it("adds each record once when two workers run the import", async () => {
    const { u, b, ids, id } = await queued(1_500);
    await Promise.all([work(id), work(id)]);
    await work(id);
    expect(await status(u, b.id, id)).toMatchObject({ status: "completed", counts: { processed: 1_500, imported: 1_500, duplicates: 0 } });
    expect(await refIds(b.id)).toEqual(ids);
  });

  // ── What an import never does ──────────────────────────────────────────────

  it("runs and charges nothing, and writes nothing to HubSpot", async () => {
    const u = await user();
    const b = await workbook(u, [{ name: "Find", type: "enrichment" }, { name: "Shout", type: "formula" }, { name: "Think", type: "ai" }, { name: "Send", type: "action" }]);
    contacts(10);
    const spending = async () => ({
      balance: await db.select().from(creditBalances).where(eq(creditBalances.workspaceId, u.workspaceId)),
      ledger: await db.select().from(creditTransactions).where(eq(creditTransactions.workspaceId, u.workspaceId)),
      jobs: await db.select().from(enrichmentJobs).where(eq(enrichmentJobs.workspaceId, u.workspaceId)),
      results: await db.select().from(enrichmentResults).where(eq(enrichmentResults.workspaceId, u.workspaceId)),
      async: await db.select().from(asyncJobs).where(eq(asyncJobs.workspaceId, u.workspaceId)),
      runs: await db.select().from(workbookRuns).where(eq(workbookRuns.workbookId, b.id)),
    });
    const before = await spending();
    await imported(u, b.id);
    expect(await spending()).toEqual(before);
    const written = await db.select().from(workbookCells).where(eq(workbookCells.workbookId, b.id));
    expect(written.some((c) => [b.col.Find, b.col.Shout, b.col.Think, b.col.Send].includes(c.columnId))).toBe(false);
    expect(hubspot.calls.filter((c) => c.method === "PATCH" || /batch\/(create|update|upsert)/.test(c.path))).toEqual([]);
  });

  it("never returns or stores a token outside the connection", async () => {
    const u = await user();
    const b = await workbook(u);
    contacts(3);
    await imported(u, b.id);
    const answers = await Promise.all([
      call(u, "GET", `/${b.id}/crm-sources`),
      call(u, "GET", `/${b.id}/crm-sources/hubspot/contact`),
      call(u, "GET", `/${b.id}/imports`),
      call(u, "GET", `/${b.id}/rows`),
      call(u, "GET", `/${b.id}/activity`),
    ]);
    for (const res of answers) expect(res.body).not.toMatch(/token-|refresh-1|client-secret|credentialsRef|enc:v1/);
    const [kept] = await sql`select (select jsonb_agg(plan) from workbook_imports where workbook_id = ${b.id})::text as plans,
      (select jsonb_agg(jsonb_build_object('s', source, 'r', crm_ref)) from workbook_rows where workbook_id = ${b.id})::text as rows`;
    expect(`${kept!.plans}${kept!.rows}`).not.toMatch(/token-|refresh-1|client-secret|enc:v1/);
  });

  it("stores a reference an action can later write back with", async () => {
    const u = await user();
    const b = await workbook(u);
    contacts(2);
    await imported(u, b.id);
    const [, second] = await stored(b.id);
    const { provider, object, id } = second!.ref;
    const connector = getCrmConnector(provider!)!;
    expect(object).toBe("contact");
    await connector.client.updateContact(u.token, id!, { jobtitle: "Updated" });
    expect(hubspot.records.contacts.map((r) => r.properties.jobtitle)).toEqual(["Director", "Updated"]);
  });

  // ── Who may ────────────────────────────────────────────────────────────────

  describe("access", () => {
    it("lets only people who may edit the workbook read the CRM or import from it", async () => {
      const owner = await user();
      const b = await workbook(owner);
      contacts(2);
      const item = await previewed(owner, b.id);
      const viewer = await colleague(owner, ["enrichment:read"]);
      for (const res of [call(viewer, "GET", `/${b.id}/crm-sources`), call(viewer, "GET", `/${b.id}/crm-sources/hubspot/contact`), preview(viewer, b.id), confirm(viewer, b.id, item.id, suggested(item))]) {
        expect((await res).statusCode).toBe(403);
      }
      const editor = await colleague(owner, ["enrichment:read", "enrichment:capture"]);
      expect((await confirm(editor, b.id, item.id, suggested(item))).statusCode).toBe(200);
    });

    it("hides another workspace's workbook and imports, and one that is deleted", async () => {
      const [mine, theirs] = [await user(), await user()];
      const a = await workbook(mine);
      const b = await workbook(theirs);
      contacts(2);
      const item = await previewed(theirs, b.id);
      hubspot.calls.length = 0;
      for (const res of [
        call(mine, "GET", `/${b.id}/crm-sources`),
        call(mine, "GET", `/${b.id}/crm-sources/hubspot/contact`),
        preview(mine, b.id),
        preview(mine, MISSING),
        confirm(mine, b.id, item.id, suggested(item)),
        confirm(mine, a.id, item.id, suggested(item)),
        call(mine, "GET", `/${a.id}/imports/${item.id}`),
      ]) {
        await refused(res, 404, "NOT_FOUND");
      }
      expect(hubspot.calls).toEqual([]);
      expect((await call(mine, "DELETE", `/${a.id}`)).statusCode).toBe(200);
      await refused(preview(mine, a.id), 404, "NOT_FOUND");
    });

    it("uses only the workspace's own connection", async () => {
      const [first, second] = [await user(), await user()];
      const b = await workbook(second);
      contacts(2);
      hubspot.calls.length = 0;
      await imported(second, b.id);
      expect(hubspot.calls.some((c) => c.token === first.token)).toBe(false);
      expect(hubspot.calls.filter((c) => c.token).every((c) => c.token === second.token)).toBe(true);
    });

    it("needs both Workbooks V2 and CRM in the plan", async () => {
      const u = await user();
      const b = await workbook(u);
      contacts(2);
      const item = await previewed(u, b.id);
      await setEntitlement(u.workspaceId, "feature.crm", false);
      for (const res of [call(u, "GET", `/${b.id}/crm-sources`), preview(u, b.id), confirm(u, b.id, item.id, suggested(item))]) {
        await refused(res, 403, "CRM_NOT_AVAILABLE");
      }
      await setEntitlement(u.workspaceId, "feature.crm", true);
      await setEntitlement(u.workspaceId, "feature.workbooks_v2", false);
      expect((await preview(u, b.id)).statusCode).toBe(403);
    });
  });

  // ── Suppression (WB2-027) ──────────────────────────────────────────────────

  describe("suppression", () => {
    it("imports a suppressed CRM contact and marks the row", async () => {
      const u = await user();
      contacts(3, 7_001);
      await db.insert(schema.suppressions).values({ workspaceId: u.workspaceId, email: "person7002@example.com" });
      const b = await workbook(u);
      const done = await imported(u, b.id);
      expect(done.counts).toMatchObject({ imported: 3 });
      const rows = await stored(b.id);
      expect(rows.map((r) => [r.ref.id, r.suppressed])).toEqual([["7001", false], ["7002", true], ["7003", false]]);
      expect(rows[1]!.source).toMatchObject({ type: "hubspot" });
    });

    it("does not mark a company because someone who works there, or its switchboard, opted out", async () => {
      const u = await user();
      companies(2, 8_001);
      await db.insert(schema.suppressions).values({ workspaceId: u.workspaceId, email: "ceo@company8001.com" });
      const b = await workbook(u);
      await imported(u, b.id, { object: "company", fields: ["name", "domain"] });
      expect((await stored(b.id)).map((r) => r.suppressed)).toEqual([false, false]);
    });
  });
});
