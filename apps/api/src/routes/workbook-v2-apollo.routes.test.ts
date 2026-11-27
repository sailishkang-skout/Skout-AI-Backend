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
import { FakeApollo, type FakeApolloCall } from "../test/fake-apollo.js";
import { importStorage } from "../services/workbook-import-storage.js";
import { runImportJob } from "../services/workbook-import-runner.js";
import { crmAccess } from "../services/workbook-crm-access.js";

/**
 * WB2-024: importing saved Apollo contacts, through the real routes against a real database. Apollo is the stand-in in
 * `test/fake-apollo.ts`; Redis is replaced by a recorder, and background jobs are run here by calling what the worker
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
const { workbooks, workbookColumns, workbookRows, workbookCells, workbookRuns, entitlements, auditLogs, enrichmentJobs, enrichmentResults, creditBalances, creditTransactions, asyncJobs, workspaceIntegrations } = schema;

interface ImportBody {
  id: string;
  sourceType: string;
  sourceName: string | null;
  crm: unknown;
  fileName: string;
  status: string;
  background: boolean;
  progress: number;
  truncated: { matched: number; considered: number; reason?: string } | null;
  counts: { total: number; processed: number; imported: number; duplicates: number; skipped: number; failed: number };
  error: { code: string; message: string } | null;
  report: { available: boolean; rows: number };
  preview: { headers: Array<{ index: number; name: string; fits: string[]; filled: number }>; rows: Array<{ line: number; values: string[] }>; suggestions: Array<{ header: number; target: any }> } | null;
}

describe.skipIf(!hasDatabase)("Workbooks V2 Apollo import", () => {
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
    INTEGRATION_ENCRYPTION_KEY: "test-integration-key-0123456789",
  };
  const apollo = new FakeApollo();
  const previousDir = process.env.WORKBOOK_IMPORTS_LOCAL_DIR;
  let dir: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let n = 0;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "wb2-apollo-test-"));
    process.env.WORKBOOK_IMPORTS_LOCAL_DIR = dir;
    app = await buildApp(config);
  });
  beforeEach(() => {
    queue.ready = true;
    queue.jobs.length = 0;
    apollo.reset();
    vi.stubGlobal("fetch", (input: any, init?: RequestInit) => (String(input?.url ?? input).startsWith("https://api.apollo.io") ? apollo.fetch(input, init) : realFetch(input, init)));
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
    key: string;
    headers: Record<string, string>;
  }

  async function person(): Promise<User> {
    n += 1;
    const email = `wb2-apollo-${suffix}-${n}@test.com`;
    const ip = `19.${Math.floor(n / 250)}.${n % 250}.7`;
    await app.inject({ method: "GET", url: "/api/v1/me", headers: { "x-stub-user-email": email }, remoteAddress: ip });
    const [u] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
    const [m] = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, u!.id));
    await db.update(schema.workspaces).set({ accessStatus: "active" }).where(eq(schema.workspaces.id, m!.workspaceId));
    await setEntitlement(m!.workspaceId, "feature.workbooks_v2", true);
    return { userId: u!.id, workspaceId: m!.workspaceId, ip, key: `apollo-secret-${suffix}-${n}`, headers: { "x-stub-user-email": email } };
  }

  /** A workspace owner who saved an Apollo key the way Settings does. */
  async function user(): Promise<User> {
    const u = await person();
    await connect(u);
    return u;
  }

  async function connect(u: User, key = u.key) {
    apollo.keys.add(key);
    const res = await app.inject({ method: "PUT", url: "/api/v1/integrations/apollo", headers: { ...u.headers, "content-type": "application/json" }, remoteAddress: u.ip, payload: JSON.stringify({ apiKey: key }) });
    expect(res.statusCode, res.body).toBe(200);
    apollo.calls.length = 0;
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
    const key = `apollo-${suffix}-${++n}`;
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
    const res = await call(u, "POST", "", { name: "Apollo" });
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

  // ── Apollo records ─────────────────────────────────────────────────────────

  const contact = (i: number): Record<string, unknown> => ({
    person_id: `person-${i}`,
    first_name: `First${i}`,
    last_name: `Last${i}`,
    name: `First${i} Last${i}`,
    email: `p${i}@company${i}.com`,
    email_status: "verified",
    title: i % 2 ? "Engineer" : "Director",
    headline: "Builds things",
    linkedin_url: `http://www.linkedin.com/in/person-${i}`,
    organization_name: `Company ${i}`,
    organization: { primary_domain: `company${i}.com`, website_url: `http://www.company${i}.com` },
    sanitized_phone: "+442079460958",
    city: "Leeds",
    state: "England",
    country: "United Kingdom",
  });
  const saved = (u: User, count: number, make: (i: number) => Record<string, unknown> = contact, first = 1) => apollo.add(u.key, count, make, first);
  const list = (id: string, name: string, members: string[], extra: Partial<(typeof apollo.lists)[number]> = {}) => apollo.lists.push({ id, name, members, ...extra });

  const FIELDS = ["name", "email", "title", "company", "company_domain", "linkedin_url", "location"];
  const preview = (u: User, workbookId: string, body: Record<string, unknown> = { search: {} }, headers: Record<string, string> = {}) =>
    call(u, "POST", `/${workbookId}/apollo-imports`, { fields: FIELDS, ...body }, headers);
  async function previewed(u: User, workbookId: string, body?: Record<string, unknown>): Promise<ImportBody> {
    const res = await preview(u, workbookId, body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json().data;
  }
  const suggested = (item: ImportBody, dedupe: Record<string, unknown> = { key: "none" }) => ({
    columns: item.preview!.suggestions.flatMap((s) => (s.target ? [{ header: s.header, ...s.target }] : [])),
    dedupe,
  });
  const confirm = (u: User, workbookId: string, importId: string, body: unknown) => call(u, "POST", `/${workbookId}/imports/${importId}/confirm`, body);
  /** Preview, accept the suggestions, and run in the background if it has to. */
  async function imported(u: User, workbookId: string, body?: Record<string, unknown>, dedupe?: Record<string, unknown>): Promise<ImportBody> {
    const item = await previewed(u, workbookId, body);
    const existing = await db.select().from(workbookColumns).where(eq(workbookColumns.workbookId, workbookId));
    const mapping = suggested(item, dedupe);
    // Columns made by an earlier import are mapped to, not made again.
    mapping.columns = mapping.columns.map((c: any) => {
      const same = c.newColumn ? existing.find((e) => e.name === c.newColumn.name) : undefined;
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
    return rows.map((r) => ({ ...r, ref: r.crmRef as Record<string, string>, from: r.source as Record<string, string>, values: byRow.get(r.id) ?? {} }));
  }
  const refIds = async (workbookId: string) => (await stored(workbookId)).map((r) => r.ref.id);
  const rowCount = async (workbookId: string) => (await db.select({ n: workbooks.rowCount }).from(workbooks).where(eq(workbooks.id, workbookId)))[0]!.n;
  const events = (workbookId: string) =>
    db.select().from(auditLogs).where(and(eq(auditLogs.entityId, workbookId), eq(auditLogs.action, "workbook.rows.added"))).orderBy(asc(auditLogs.createdAt));
  const refused = async (res: ReturnType<typeof call>, httpStatus: number, code: string) => {
    const answer = await res;
    expect(answer.statusCode, answer.body).toBe(httpStatus);
    expect(answer.json().code).toBe(code);
    expect(answer.body).not.toMatch(/secret detail|apollo-secret/);
    return answer.json();
  };
  const isPage = (page: number) => (c: FakeApolloCall) => c.path === "/api/v1/contacts/search" && c.body.page === page && c.body.per_page === 100;

  /** A confirmed background import of `count` contacts, not yet run. */
  async function queued(count: number, body?: Record<string, unknown>) {
    const u = await user();
    const b = await workbook(u);
    const ids = saved(u, count);
    const item = await previewed(u, b.id, body);
    expect((await confirm(u, b.id, item.id, suggested(item))).statusCode).toBe(202);
    return { u, b, ids, id: item.id };
  }

  // ── What can be chosen ─────────────────────────────────────────────────────

  describe("source", () => {
    const describeSource = (u: User, workbookId: string) => call(u, "GET", `/${workbookId}/apollo-source`);

    it("says Apollo isn't connected, and asks Apollo nothing", async () => {
      const u = await person();
      const b = await workbook(u);
      const res = await describeSource(u, b.id);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data).toMatchObject({ connection: { status: "not_connected" }, lists: null, stages: null, maxRecords: 50_000 });
      await refused(preview(u, b.id), 409, "APOLLO_NOT_CONNECTED");
      expect(apollo.calls).toEqual([]);
    });

    it("offers the account's contact lists, stages and fields, and no key", async () => {
      const u = await user();
      const b = await workbook(u);
      const ids = saved(u, 3);
      list("list-1", "Prospects", ids);
      list("list-2", "Target accounts", [], { modality: "accounts" });
      list("list-3", "A sequence", [], { modality: "emailer_campaigns" });
      apollo.stages = [{ id: "stage-1", name: "cold", display_name: "Cold" }, { id: "stage-2", name: "Approaching" }];
      const res = await describeSource(u, b.id);
      expect(res.statusCode, res.body).toBe(200);
      const data = res.json().data;
      expect(data.connection).toEqual({ status: "connected" });
      expect(data.lists).toEqual({ available: true, reason: null, items: [{ id: "list-1", name: "Prospects", count: 3 }] });
      expect(data.stages.items).toEqual([{ id: "stage-1", name: "Cold" }, { id: "stage-2", name: "Approaching" }]);
      expect(data.defaultFields).toEqual(FIELDS);
      expect(data.fields.map((f: any) => f.name)).toEqual(expect.arrayContaining([...FIELDS, "first_name", "last_name", "phone"]));
      expect(data.note).toContain("saved searches aren't available");
      expect(res.body).not.toContain(u.key);
      expect(apollo.calls.every((c) => c.key === u.key && c.method === "GET" && !c.url.includes(u.key))).toBe(true);
    });

    it("says to save a new key when Apollo rejects the saved one", async () => {
      const u = await user();
      const b = await workbook(u);
      apollo.keys.delete(u.key);
      const body = await refused(describeSource(u, b.id), 409, "APOLLO_RECONNECT_REQUIRED");
      expect(body.message ?? body.error).toContain("Save a valid key in Settings");
      await refused(preview(u, b.id), 409, "APOLLO_RECONNECT_REQUIRED");
      // The saved key is left for the workspace to change.
      expect(await db.select().from(workspaceIntegrations).where(eq(workspaceIntegrations.workspaceId, u.workspaceId))).toMatchObject([{ status: "active" }]);
    });

    it("treats a stored key that can't be read as one to save again", async () => {
      const u = await user();
      const b = await workbook(u);
      await db.update(workspaceIntegrations).set({ encryptedApiKey: "not-a-key" }).where(eq(workspaceIntegrations.workspaceId, u.workspaceId));
      expect((await describeSource(u, b.id)).json().data.connection.status).toBe("needs_reauth");
      await refused(preview(u, b.id), 409, "APOLLO_RECONNECT_REQUIRED");
    });

    it("still searches when the key may not read lists, and says why lists are missing", async () => {
      const u = await user();
      const b = await workbook(u);
      saved(u, 2);
      apollo.forbidden.set(u.key, new Set(["/api/v1/labels"]));
      const data = (await describeSource(u, b.id)).json().data;
      expect(data.lists).toMatchObject({ available: false, items: [] });
      expect(data.lists.reason).toContain("isn't allowed to read this");
      expect(data.stages.available).toBe(true);
      expect((await imported(u, b.id)).counts.imported).toBe(2);
      await refused(preview(u, b.id, { listId: "list-1" }), 409, "APOLLO_SCOPE_MISSING");
    });

    it("explains a key that may not read contacts", async () => {
      const u = await user();
      const b = await workbook(u);
      apollo.forbidden.set(u.key, new Set(["/api/v1/contacts/search"]));
      await refused(preview(u, b.id), 409, "APOLLO_SCOPE_MISSING");
    });

    it.each([
      [429, 429, "APOLLO_RATE_LIMITED"],
      [500, 502, "APOLLO_UNAVAILABLE"],
      [422, 422, "APOLLO_SEARCH_REJECTED"],
    ])("explains an Apollo answer of %i at the preview", async (from, httpStatus, code) => {
      const u = await user();
      const b = await workbook(u);
      saved(u, 2);
      apollo.fail((c) => c.path === "/api/v1/contacts/search", from, { headers: { "retry-after": "1" } });
      const body = await refused(preview(u, b.id), httpStatus, code);
      if (from === 429) expect(body.details).toEqual({ retryAfterMs: 1_000 });
      // Someone waiting on a request is not made to wait for the limit to lift.
      expect(apollo.searches()).toHaveLength(1);
      expect(await db.select().from(schema.workbookImports).where(eq(schema.workbookImports.workbookId, b.id))).toEqual([]);
    });
  });

  // ── Preview ────────────────────────────────────────────────────────────────

  describe("preview", () => {
    it("reads the first saved contacts, suggests columns, and adds nothing", async () => {
      const u = await user();
      const b = await workbook(u);
      saved(u, 40);
      const item = await previewed(u, b.id);
      expect(item).toMatchObject({ sourceType: "apollo", status: "awaiting_confirmation", crm: null, sourceName: null, fileName: "Apollo contacts", counts: { total: 40 } });
      expect(item.preview!.rows).toHaveLength(20);
      expect(item.preview!.rows[0]!.values).toEqual([
        "First1 Last1",
        "p1@company1.com",
        "Engineer",
        "Company 1",
        "company1.com",
        "http://www.linkedin.com/in/person-1",
        "Leeds, England, United Kingdom",
      ]);
      const targets = item.preview!.suggestions.map((s) => s.target.newColumn);
      expect(targets.map((t) => t.name)).toEqual(["Full name", "Email", "Title", "Company", "Company domain", "LinkedIn URL", "Location"]);
      expect(targets.map((t) => t.dataType)).toEqual(["text", "email", "text", "text", "domain", "linkedin_url", "text"]);
      expect(await stored(b.id)).toEqual([]);
      expect(await db.select().from(workbookColumns).where(eq(workbookColumns.workbookId, b.id))).toEqual([]);
      expect(apollo.searches()).toHaveLength(1);
      expect(apollo.searches()[0]!.body).toEqual({ page: 1, per_page: 20, sort_by_field: "contact_created_at", sort_ascending: true });
    });

    it("asks Apollo only for the chosen list, and names it", async () => {
      const u = await user();
      const b = await workbook(u);
      const ids = saved(u, 6);
      list("list-1", "Prospects", ids.slice(2, 4), { cachedCount: 900 });
      const item = await previewed(u, b.id, { listId: "list-1" });
      expect(item).toMatchObject({ sourceName: "Prospects", fileName: "Apollo contacts · Prospects", counts: { total: 2 } });
      expect(item.preview!.rows.map((r) => r.values[0])).toEqual(["First3 Last3", "First4 Last4"]);
      expect(apollo.searches()[0]!.body.contact_label_ids).toEqual(["list-1"]);
    });

    it("searches by keywords and stages", async () => {
      const u = await user();
      const b = await workbook(u);
      saved(u, 8, (i) => ({ ...contact(i), contact_stage_id: i > 4 ? "stage-2" : "stage-1" }));
      apollo.stages = [{ id: "stage-1", name: "Cold" }, { id: "stage-2", name: "Warm" }];
      const item = await previewed(u, b.id, { search: { keywords: "  Director ", stageIds: ["stage-2"] } });
      expect(item).toMatchObject({ fileName: "Apollo contacts · search", counts: { total: 2 } });
      expect(apollo.searches()[0]!.body).toMatchObject({ q_keywords: "Director", contact_stage_ids: ["stage-2"] });
    });

    it("refuses a malformed request without asking Apollo", async () => {
      const u = await user();
      const b = await workbook(u);
      saved(u, 2);
      const bad: Array<Record<string, unknown>> = [
        {},
        { listId: "list-1", search: {} },
        { search: {}, fields: [] },
        { search: {}, fields: ["email", "email"] },
        { search: {}, fields: ["Email Address"] },
        { listId: "../../labels" },
        { search: { stageIds: ["a", "a"] } },
        { search: { keywords: "x".repeat(201) } },
        { search: { keywords: "a\u0000b" } },
        { search: { filters: [] } },
        { search: {}, apiKey: "mine" },
        { search: {}, connectionId: MISSING },
        { search: {}, workspaceId: MISSING },
        { search: {}, provider: "hubspot" },
      ];
      for (const body of bad) expect((await call(u, "POST", `/${b.id}/apollo-imports`, { fields: FIELDS, ...body })).statusCode, JSON.stringify(body)).toBe(422);
      expect(apollo.calls).toEqual([]);
    });

    it("refuses a field, list or stage Apollo doesn't have", async () => {
      const u = await user();
      const b = await workbook(u);
      saved(u, 2);
      list("accounts-1", "Accounts", [], { modality: "accounts" });
      await refused(preview(u, b.id, { search: {}, fields: ["email", "salary"] }), 422, "APOLLO_UNKNOWN_FIELD");
      await refused(preview(u, b.id, { listId: "nope" }), 422, "APOLLO_UNKNOWN_LIST");
      await refused(preview(u, b.id, { listId: "accounts-1" }), 422, "APOLLO_UNKNOWN_LIST");
      await refused(preview(u, b.id, { search: { stageIds: ["nope"] } }), 422, "APOLLO_UNKNOWN_STAGE");
    });

    it("says when there is nothing to import", async () => {
      const u = await user();
      const b = await workbook(u);
      const empty = await refused(preview(u, b.id), 422, "NOTHING_TO_ADD");
      expect(JSON.stringify(empty)).toContain("no contacts yet");
      saved(u, 2);
      const none = await refused(preview(u, b.id, { search: { keywords: "nobody" } }), 422, "NOTHING_TO_ADD");
      expect(JSON.stringify(none)).toContain("in this selection");
    });

    it("doesn't take an answer it doesn't understand for an empty one", async () => {
      const u = await user();
      const b = await workbook(u);
      saved(u, 2);
      const stub = globalThis.fetch;
      vi.stubGlobal("fetch", (input: any, init?: RequestInit) =>
        String(input).endsWith("/contacts/search") ? Promise.resolve(new Response(JSON.stringify({ people: [] }), { status: 200 })) : stub(input, init)
      );
      await refused(preview(u, b.id), 502, "APOLLO_UNAVAILABLE");
    });

    it("makes one preview for a repeated request", async () => {
      const u = await user();
      const b = await workbook(u);
      saved(u, 2);
      const key = { "idempotency-key": randomUUID() };
      const [first, again] = [await preview(u, b.id, { search: {} }, key), await preview(u, b.id, { search: {} }, key)];
      expect(again.json().data.id).toBe(first.json().data.id);
      expect(apollo.searches()).toHaveLength(1);
    });
  });

  // ── Importing ──────────────────────────────────────────────────────────────

  it("adds every contact of a list with its reference, source and one activity entry", async () => {
    const u = await user();
    const b = await workbook(u);
    const ids = saved(u, 12);
    list("list-1", "Prospects", ids.slice(0, 3));
    const done = await imported(u, b.id, { listId: "list-1", fields: [...FIELDS, "phone"] });
    expect(done).toMatchObject({ status: "completed", background: false, sourceName: "Prospects", crm: null, truncated: null, counts: { total: 3, processed: 3, imported: 3, duplicates: 0, skipped: 0, failed: 0 } });
    const rows = await stored(b.id);
    expect(rows.map((r) => r.ref)).toEqual([1, 2, 3].map((i) => ({ provider: "apollo", object: "contact", id: `contact-${i}`, personId: `person-${i}` })));
    expect(rows[0]!.values).toEqual({
      "Full name": "First1 Last1",
      Email: "p1@company1.com",
      Title: "Engineer",
      Company: "Company 1",
      "Company domain": "company1.com",
      "LinkedIn URL": "http://www.linkedin.com/in/person-1",
      Location: "Leeds, England, United Kingdom",
      "Phone": "+442079460958",
    });
    expect(rows[0]!.from).toEqual({ type: "apollo", object: "contact", importId: done.id, importedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/), viewId: "list-1", viewName: "Prospects" });
    expect(rows[0]!.prospectId).toBeNull();
    expect(await rowCount(b.id)).toBe(3);
    const types = (await db.select().from(workbookColumns).where(eq(workbookColumns.workbookId, b.id))).map((c) => [c.name, c.type, (c.config as any).dataType]);
    expect(types).toEqual(expect.arrayContaining([["Email", "input", "email"], ["Company domain", "input", "domain"], ["LinkedIn URL", "input", "linkedin_url"], ["Phone", "input", "phone"]]));

    const [event, ...more] = await events(b.id);
    expect(more).toEqual([]);
    expect(event).toMatchObject({ actorId: u.userId, afterState: { source: "apollo", object: "contact", viewName: "Prospects", status: "completed", rows: 3, rowCount: 3, duplicates: 0, skipped: 0, failed: 0 } });
    const feed = (await call(u, "GET", `/${b.id}/activity`)).json().data.find((e: any) => e.type === "rows.added");
    expect(feed).toMatchObject({ actor: { id: u.userId }, details: { source: "apollo", status: "completed", rows: 3, duplicates: 0, viewName: "Prospects" } });
  });

  it("keeps what was searched for on the rows, and the words searched out of the activity log", async () => {
    const u = await user();
    const b = await workbook(u);
    saved(u, 6, (i) => ({ ...contact(i), contact_stage_id: "stage-1" }));
    apollo.stages = [{ id: "stage-1", name: "Cold" }];
    const done = await imported(u, b.id, { search: { keywords: "Engineer", stageIds: ["stage-1"] } });
    expect(done.counts.imported).toBe(3);
    const rows = await stored(b.id);
    expect(rows[0]!.from).toMatchObject({ type: "apollo", searchKeywords: "Engineer", searchStages: "Cold" });
    expect(rows[0]!.from).not.toHaveProperty("viewId");
    // Words searched for can be someone's name or address, which activity records never hold.
    expect(JSON.stringify((await events(b.id))[0]!.afterState)).not.toContain("Engineer");
  });

  it("runs more than 1,000 contacts in the background, page by page, with real progress", async () => {
    const { u, b, ids, id } = await queued(2_350);
    expect(queue.jobs).toEqual([{ importId: id, workspaceId: u.workspaceId }]);
    expect(await status(u, b.id, id)).toMatchObject({ status: "queued", background: true, progress: 0, counts: { total: 2_350, processed: 0 } });
    const seen: number[] = [];
    apollo.onCall = async (c) => {
      if (c.body.per_page === 100 && (c.body.page === 11 || c.body.page === 21)) seen.push((await status(u, b.id, id)).counts.processed);
    };
    apollo.calls.length = 0;
    await work(id);
    expect(seen).toEqual([1_000, 2_000]);
    expect(await status(u, b.id, id)).toMatchObject({ status: "completed", progress: 100, counts: { total: 2_350, processed: 2_350, imported: 2_350 } });
    expect(apollo.searches().map((c) => c.body.page)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    expect(await refIds(b.id)).toEqual(ids);
    expect(await events(b.id)).toHaveLength(1);
  });

  it("says when Apollo holds more than it will let anyone read", async () => {
    const { u, b, id } = await queued(50_150);
    expect(await status(u, b.id, id)).toMatchObject({ counts: { total: 50_000 } });
    // Start at the last page Apollo allows, as an import that had read the others would.
    await sql`update workbook_imports set plan = jsonb_set(plan, '{crm,cursor}', '"500"') where id = ${id}`;
    await work(id);
    expect(await status(u, b.id, id)).toMatchObject({
      status: "completed",
      counts: { imported: 100, processed: 100, total: 100 },
      truncated: { matched: 50_150, considered: 100, reason: "source_limit" },
    });
    expect(apollo.searches().filter((c) => (c.body.page as number) > 500)).toEqual([]);
  });

  // ── Values ─────────────────────────────────────────────────────────────────

  it("leaves missing values empty, and reports only the records it can't import", async () => {
    const u = await user();
    const b = await workbook(u);
    saved(u, 30, (i) => {
      if (i === 22) return { first_name: "Only", last_name: "Name" };
      if (i === 23) return {};
      if (i === 24) return { ...contact(i), email: "not an address" };
      if (i === 25) return { ...contact(i), email: "email_not_unlocked@domain.com", organization: undefined, account: { domain: "from-account.com" } };
      if (i === 26) return { ...contact(i), city: null, state: "", country: undefined, present_raw_address: "Leeds, UK", organization: { website_url: "https://www.from-website.com/about" }, sanitized_phone: null, phone_numbers: [{ raw_number: "+44 20 7946 0000" }] };
      return contact(i);
    });
    const done = await imported(u, b.id, { search: {}, fields: [...FIELDS, "phone"] });
    expect(done).toMatchObject({ status: "completed", counts: { processed: 30, imported: 28, failed: 1, skipped: 1 } });
    const rows = await stored(b.id);
    const row = (i: number) => rows.find((r) => r.ref.id === `contact-${i}`)!;
    expect(row(22).values).toEqual({ "Full name": "Only Name" });
    expect(row(22).ref).not.toHaveProperty("personId");
    expect(row(25).values).toMatchObject({ "Company domain": "from-account.com" });
    expect(row(25).values).not.toHaveProperty("Email");
    expect(row(26).values).toMatchObject({ "Company domain": "from-website.com", Location: "Leeds, UK", Phone: "+44 20 7946 0000" });
    const lines = await report(u, b.id, done.id);
    expect(lines[0]).toContain("Apollo contact ID");
    expect(lines.find((l) => l.includes("contact-23"))).toContain("Skipped");
    expect(lines.find((l) => l.includes("contact-24"))).toMatch(/Invalid value.*Email: not a valid email/);
  });

  it("imports into chosen existing columns", async () => {
    const u = await user();
    const b = await workbook(u, [{ name: "Work email", dataType: "email" }, { name: "Who" }]);
    saved(u, 3);
    const item = await previewed(u, b.id, { search: {}, fields: ["name", "email"] });
    const res = await confirm(u, b.id, item.id, { columns: [{ header: 0, columnId: b.col.Who }, { header: 1, columnId: b.col["Work email"] }], dedupe: { key: "none" } });
    expect(res.statusCode, res.body).toBe(200);
    expect((await stored(b.id))[0]!.values).toEqual({ Who: "First1 Last1", "Work email": "p1@company1.com" });
    expect(await db.select().from(workbookColumns).where(eq(workbookColumns.workbookId, b.id))).toHaveLength(2);
  });

  it("refuses a column that cannot hold the field, and changes nothing", async () => {
    const u = await user();
    const b = await workbook(u, [{ name: "Count", dataType: "number" }, { name: "Find", type: "enrichment" }]);
    saved(u, 3);
    const item = await previewed(u, b.id, { search: {}, fields: ["name", "email"] });
    await refused(confirm(u, b.id, item.id, { columns: [{ header: 0, columnId: b.col.Count }], dedupe: { key: "none" } }), 422, "INVALID_IMPORT_MAPPING");
    await refused(confirm(u, b.id, item.id, { columns: [{ header: 1, columnId: b.col.Find }], dedupe: { key: "none" } }), 422, "INVALID_IMPORT_MAPPING");
    await refused(confirm(u, b.id, item.id, { columns: [{ header: 1, columnId: MISSING }], dedupe: { key: "none" } }), 422, "INVALID_IMPORT_MAPPING");
    expect(await stored(b.id)).toEqual([]);
  });

  // ── Duplicates ─────────────────────────────────────────────────────────────

  it.each([
    ["email", "Email", "email", "P1@Company1.com", (i: number) => ({ email: i === 4 ? "p3@company3.com" : `p${i}@company${i}.com` })],
    [
      "linkedin_url",
      "LinkedIn URL",
      "linkedin_url",
      "https://uk.linkedin.com/in/person-1/?utm=x",
      (i: number) => ({ linkedin_url: `http://www.linkedin.com/in/person-${i === 4 ? 3 : i}` }),
    ],
    ["domain", "Company domain", "domain", "company1.com", (i: number) => ({ organization: { primary_domain: `company${i === 4 ? 3 : i}.com` } })],
  ])("skips duplicates by %s, within the import and against rows already there, changing none", async (key, column, dataType, existing, differs) => {
    const u = await user();
    const b = await workbook(u, [{ name: column, dataType }, { name: "Title" }]);
    expect((await call(u, "POST", `/${b.id}/rows`, { cells: { [b.col[column]!]: existing, [b.col.Title!]: "Kept as it was" } })).statusCode).toBe(201);
    saved(u, 5, (i) => ({ ...contact(i), ...differs(i) }));
    const done = await imported(u, b.id, undefined, { key });
    // The first is already in the workbook; the fourth repeats the third.
    expect(done.counts).toMatchObject({ processed: 5, imported: 3, duplicates: 2, failed: 0 });
    const rows = await stored(b.id);
    expect(rows).toHaveLength(4);
    expect(rows[0]!.values).toEqual({ [column]: existing, Title: "Kept as it was" });
    expect(rows.slice(1).map((r) => r.ref.id)).toEqual(["contact-2", "contact-3", "contact-5"]);
    expect((await report(u, b.id, done.id)).filter((l) => l.includes("Duplicate"))).toHaveLength(2);
    expect((await events(b.id)).at(-1)!.afterState).toMatchObject({ rows: 3, duplicates: 2 });
  });

  it("with no duplicate key imports contacts that share values, but never one contact twice", async () => {
    const u = await user();
    const b = await workbook(u);
    const ids = saved(u, 4, (i) => ({ ...contact(i), email: "shared@example.com" }));
    list("list-1", "Prospects", ids.slice(0, 2));
    expect((await imported(u, b.id)).counts).toMatchObject({ imported: 4, duplicates: 0 });
    saved(u, 1, contact, 5);
    // A contact already here is skipped, whichever selection brings it, and even after the key is saved again.
    await connect(u, `${u.key}-new`);
    apollo.contacts.set(`${u.key}-new`, apollo.contacts.get(u.key)!);
    expect((await imported(u, b.id)).counts).toMatchObject({ imported: 1, duplicates: 4 });
    expect((await imported(u, b.id, { listId: "list-1" })).counts).toMatchObject({ imported: 0, duplicates: 2 });
    expect(await refIds(b.id)).toEqual([...ids, "contact-5"]);
    // An import that adds nothing is still recorded, with what happened.
    const entries = await events(b.id);
    expect(entries).toHaveLength(3);
    expect(entries.at(-1)!.afterState).toMatchObject({ status: "completed", rows: 0, duplicates: 2 });
  });

  it("adds a contact once when Apollo hands it over twice", async () => {
    const u = await user();
    const b = await workbook(u);
    saved(u, 3);
    const mine = apollo.contacts.get(u.key)!;
    mine.push(mine[0]!);
    expect((await imported(u, b.id)).counts).toMatchObject({ processed: 4, imported: 3, duplicates: 1 });
  });

  // ── Row limit ──────────────────────────────────────────────────────────────

  it("fills the workbook to its limit, reports the rest, and stops reading", async () => {
    const u = await user();
    await setEntitlement(u.workspaceId, "workbooks.row_limit", 650);
    const b = await workbook(u);
    saved(u, 3_000);
    const done = await imported(u, b.id);
    expect(done).toMatchObject({ status: "completed", counts: { imported: 650, processed: 1_000, total: 1_000, failed: 350 }, truncated: { matched: 3_000, considered: 1_000 } });
    expect(done.truncated).not.toHaveProperty("reason");
    expect(await rowCount(b.id)).toBe(650);
    expect(apollo.searches().length).toBeLessThanOrEqual(11);
    expect((await report(u, b.id, done.id))[1]).toContain("Over the row limit");
    const next = await previewed(u, b.id);
    await refused(confirm(u, b.id, next.id, { columns: [{ header: 0, newColumn: { name: "Other", dataType: "text" } }], dedupe: { key: "none" } }), 422, "ROW_LIMIT_EXCEEDED");
    expect(await rowCount(b.id)).toBe(650);
  });

  // ── Retries, rate limits and failures ──────────────────────────────────────

  it("carries on from where it stopped after Apollo fails part way", async () => {
    const { u, b, ids, id } = await queued(1_600);
    apollo.fail(isPage(8), 503);
    await expect(work(id)).rejects.toThrow("Try later (APOLLO_UNAVAILABLE)");
    expect(await status(u, b.id, id)).toMatchObject({ status: "processing", counts: { processed: 500, imported: 500 } });
    apollo.calls.length = 0;
    await work(id);
    expect(await status(u, b.id, id)).toMatchObject({ status: "completed", counts: { processed: 1_600, imported: 1_600, duplicates: 0 } });
    expect(apollo.searches()[0]!.body.page).toBe(6);
    expect(await refIds(b.id)).toEqual(ids);
    expect(await events(b.id)).toHaveLength(1);
    await work(id);
    expect(await rowCount(b.id)).toBe(1_600);
  });

  it("waits out a short rate limit in the background", async () => {
    const { u, b, id } = await queued(1_100);
    apollo.fail(isPage(4), 429, { times: 2, headers: { "retry-after": "1" } });
    const started = Date.now();
    await work(id);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
    expect(await status(u, b.id, id)).toMatchObject({ status: "completed", counts: { imported: 1_100 } });
    expect(apollo.searches().filter(isPage(4))).toHaveLength(3);
  });

  it.each([
    ["a long one", "3600", 1, 1],
    ["one that doesn't lift", "1", 10, 4],
  ])("goes back to the queue for %s", async (_what, after, times, asked) => {
    const { u, b, id } = await queued(1_100);
    apollo.fail(isPage(7), 429, { times, headers: { "retry-after": after } });
    apollo.calls.length = 0;
    await expect(work(id)).rejects.toThrow("Try later (APOLLO_RATE_LIMITED)");
    expect(apollo.searches().filter(isPage(7))).toHaveLength(asked);
    expect(await status(u, b.id, id)).toMatchObject({ status: "processing", error: null, counts: { processed: 500 } });
  });

  it("does not give up on a busy Apollo at the last attempt", async () => {
    const { u, b, id } = await queued(1_100);
    apollo.fail(isPage(1), 500);
    await expect(work(id, true)).rejects.toThrow("Try later");
    expect((await status(u, b.id, id)).status).toBe("processing");
    await work(id);
    expect((await status(u, b.id, id)).counts.imported).toBe(1_100);
  });

  it("moves a small import into the background when Apollo is busy, or says so if it can't", async () => {
    const u = await user();
    const b = await workbook(u);
    saved(u, 30);
    const item = await previewed(u, b.id);
    apollo.fail((c) => c.path === "/api/v1/contacts/search", 429, { headers: { "retry-after": "1" } });
    expect((await confirm(u, b.id, item.id, suggested(item))).json().data.status).toBe("processing");
    expect(queue.jobs).toHaveLength(1);
    await work(item.id);
    expect((await status(u, b.id, item.id)).counts.imported).toBe(30);

    const other = await workbook(u);
    const second = await previewed(u, other.id);
    queue.ready = false;
    apollo.fail((c) => c.path === "/api/v1/contacts/search", 429, { headers: { "retry-after": "1" } });
    const res = await confirm(u, other.id, second.id, suggested(second));
    expect(res.json().data).toMatchObject({ status: "failed", error: { code: "APOLLO_RATE_LIMITED" } });
  });

  it("fails after repeated unexpected errors, keeping what it added and recording it", async () => {
    const { u, b, id } = await queued(1_600);
    await withFailingCellInserts(sql, `wb2_apollo_boom_${suffix}`, `new.value = '"First700 Last700"'::jsonb`, async () => {
      await expect(work(id)).rejects.toThrow();
      await expect(work(id, true)).rejects.toThrow();
    });
    expect(await status(u, b.id, id)).toMatchObject({ status: "failed", error: { code: "IMPORT_FAILED" }, counts: { imported: 500 } });
    expect(await rowCount(b.id)).toBe(500);
    expect((await events(b.id))[0]!.afterState).toMatchObject({ status: "failed", rows: 500 });
    // Importing the same selection again adds the rest, once each.
    expect((await imported(u, b.id)).counts).toMatchObject({ imported: 1_100, duplicates: 500 });
  });

  it("stops when the key is rejected part way, says what to do, and finishes the rest with a new one", async () => {
    const { u, b, id } = await queued(1_600);
    apollo.onCall = (c) => {
      if (isPage(8)(c)) apollo.keys.delete(u.key);
    };
    await work(id);
    const failed = await status(u, b.id, id);
    expect(failed).toMatchObject({ status: "failed", error: { code: "APOLLO_RECONNECT_REQUIRED" }, counts: { processed: 500, imported: 500 } });
    expect(failed.error!.message).toContain("importing again skips them");
    expect(JSON.stringify(failed)).not.toMatch(/secret detail|apollo-secret/);
    expect((await events(b.id))[0]).toMatchObject({ actorId: u.userId, afterState: { status: "failed", rows: 500 } });
    apollo.onCall = null;
    await connect(u, `${u.key}-new`);
    apollo.contacts.set(`${u.key}-new`, apollo.contacts.get(u.key)!);
    expect((await imported(u, b.id)).counts).toMatchObject({ imported: 1_100, duplicates: 500 });
  });

  it("records an import that fails before adding anything", async () => {
    const { u, b, id } = await queued(1_100);
    apollo.keys.delete(u.key);
    await work(id);
    expect(await status(u, b.id, id)).toMatchObject({ status: "failed", error: { code: "APOLLO_RECONNECT_REQUIRED" }, counts: { imported: 0 } });
    expect((await events(b.id)).map((e) => e.afterState)).toMatchObject([{ source: "apollo", status: "failed", rows: 0 }]);
  });

  it.each([
    [403, "APOLLO_SCOPE_MISSING"],
    [422, "APOLLO_SEARCH_REJECTED"],
  ])("stops on an Apollo answer of %i part way", async (from, code) => {
    const { u, b, id } = await queued(1_100);
    apollo.fail(isPage(6), from);
    await work(id);
    expect(await status(u, b.id, id)).toMatchObject({ status: "failed", error: { code }, counts: { imported: 500 } });
  });

  it.each([
    ["while it is being read", 8, 500],
    ["before it starts", 0, 0],
  ])("stops when the list is deleted %s, rather than ending as if it were done", async (_when, at, kept) => {
    const u = await user();
    const b = await workbook(u);
    const ids = saved(u, 1_600);
    list("list-1", "Prospects", ids);
    const item = await previewed(u, b.id, { listId: "list-1" });
    expect((await confirm(u, b.id, item.id, suggested(item))).statusCode).toBe(202);
    if (at) {
      apollo.onCall = (c) => {
        if (isPage(at)(c)) apollo.lists = [];
      };
    } else apollo.lists = [];
    await work(item.id);
    expect(await status(u, b.id, item.id)).toMatchObject({ status: "failed", error: { code: "APOLLO_UNKNOWN_LIST" }, counts: { imported: kept } });
  });

  it("does not start, or go on, with a different saved key than the preview used", async () => {
    const u = await user();
    const b = await workbook(u);
    saved(u, 3);
    const item = await previewed(u, b.id);
    await connect(u, `${u.key}-other`);
    await refused(confirm(u, b.id, item.id, suggested(item)), 409, "APOLLO_CONNECTION_CHANGED");
    expect(await stored(b.id)).toEqual([]);

    const running = await queued(1_600);
    await connect(running.u, `${running.u.key}-other`);
    apollo.calls.length = 0;
    await work(running.id);
    expect(await status(running.u, running.b.id, running.id)).toMatchObject({ status: "failed", error: { code: "APOLLO_CONNECTION_CHANGED" }, counts: { imported: 0 } });
    expect(apollo.calls).toEqual([]);
  });

  it("refuses to confirm once Apollo is disconnected, and stops a running import", async () => {
    const u = await user();
    const b = await workbook(u);
    saved(u, 3);
    const item = await previewed(u, b.id);
    const running = await queued(1_100);
    for (const who of [u, running.u]) {
      expect((await app.inject({ method: "DELETE", url: "/api/v1/integrations/apollo", headers: who.headers, remoteAddress: who.ip })).statusCode).toBe(204);
    }
    await refused(confirm(u, b.id, item.id, suggested(item)), 409, "APOLLO_NOT_CONNECTED");
    await work(running.id);
    expect(await status(running.u, running.b.id, running.id)).toMatchObject({ status: "failed", error: { code: "APOLLO_NOT_CONNECTED" } });
  });

  it("adds each contact once when two workers run the import", async () => {
    const { u, b, ids, id } = await queued(1_600);
    await Promise.all([work(id), work(id)]);
    await work(id);
    expect(await status(u, b.id, id)).toMatchObject({ status: "completed", counts: { imported: 1_600 } });
    expect((await refIds(b.id)).sort()).toEqual([...ids].sort());
    expect(await events(b.id)).toHaveLength(1);
  });

  // ── What an import never does ──────────────────────────────────────────────

  it("runs and charges nothing, and writes nothing to Apollo", async () => {
    const u = await user();
    const b = await workbook(u, [{ name: "Find", type: "enrichment" }, { name: "Shout", type: "formula" }, { name: "Think", type: "ai" }, { name: "Send", type: "action" }]);
    saved(u, 10);
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
    // Only reads: the one POST is Apollo's search.
    expect(apollo.calls.filter((c) => c.method !== "GET" && c.path !== "/api/v1/contacts/search")).toEqual([]);
  });

  it("sends the key only in Apollo's header, and never returns or stores it", async () => {
    const u = await user();
    const b = await workbook(u);
    const ids = saved(u, 3);
    list("list-1", "Prospects", ids);
    const first = await preview(u, b.id, { listId: "list-1" });
    const item = first.json().data as ImportBody;
    const confirmed = await confirm(u, b.id, item.id, suggested(item));
    expect(apollo.calls.every((c) => c.key === u.key && !c.url.includes(u.key) && !JSON.stringify(c.body).includes(u.key))).toBe(true);
    const answers = [
      first,
      confirmed,
      ...(await Promise.all([`/apollo-source`, `/imports`, `/imports/${item.id}`, `/rows`, `/activity`].map((p) => call(u, "GET", `/${b.id}${p}`)))),
    ];
    for (const res of answers) expect(res.body).not.toMatch(/apollo-secret|enc:v1|encryptedApiKey/);
    const [kept] = await sql`select (select jsonb_agg(to_jsonb(i)) from workbook_imports i where workbook_id = ${b.id})::text as imports,
      (select jsonb_agg(jsonb_build_object('s', source, 'r', crm_ref)) from workbook_rows where workbook_id = ${b.id})::text as rows,
      (select jsonb_agg(to_jsonb(a)) from audit_logs a where entity_id = ${b.id})::text as audit`;
    expect(`${kept!.imports}${kept!.rows}${kept!.audit}`).not.toContain("apollo-secret");
  });

  // ── Who may ────────────────────────────────────────────────────────────────

  describe("access", () => {
    const attempts = (who: User, workbookId: string, item: ImportBody) => [
      call(who, "GET", `/${workbookId}/apollo-source`),
      preview(who, workbookId),
      confirm(who, workbookId, item.id, suggested(item)),
    ];

    it("lets only people who may edit the workbook read Apollo or import from it", async () => {
      const owner = await user();
      const b = await workbook(owner);
      saved(owner, 2);
      const item = await previewed(owner, b.id);
      const viewer = await colleague(owner, ["enrichment:read"]);
      apollo.calls.length = 0;
      for (const res of attempts(viewer, b.id, item)) expect((await res).statusCode).toBe(403);
      expect(apollo.calls).toEqual([]);
      const editor = await colleague(owner, ["enrichment:read", "enrichment:capture"]);
      expect((await confirm(editor, b.id, item.id, suggested(item))).statusCode).toBe(200);
      expect((await events(b.id))[0]!.actorId).toBe(editor.userId);
    });

    it("hides another workspace's workbook and imports, and one that is deleted", async () => {
      const [mine, theirs] = [await user(), await user()];
      const a = await workbook(mine);
      const b = await workbook(theirs);
      saved(theirs, 2);
      saved(mine, 2);
      const item = await previewed(theirs, b.id);
      apollo.calls.length = 0;
      for (const res of [
        ...attempts(mine, b.id, item),
        preview(mine, MISSING),
        confirm(mine, a.id, item.id, suggested(item)),
        call(mine, "GET", `/${a.id}/imports/${item.id}`),
        call(mine, "GET", `/${a.id}/imports/${item.id}/report`),
        call(mine, "DELETE", `/${a.id}/imports/${item.id}`),
      ]) {
        await refused(res, 404, "NOT_FOUND");
      }
      expect((await call({ ...mine, headers: { ...mine.headers, "x-workspace-id": theirs.workspaceId } }, "GET", `/${b.id}/apollo-source`)).statusCode).toBeGreaterThanOrEqual(403);
      expect(apollo.calls).toEqual([]);
      expect((await status(theirs, b.id, item.id)).status).toBe("awaiting_confirmation");
      expect((await call(mine, "DELETE", `/${a.id}`)).statusCode).toBe(200);
      await refused(preview(mine, a.id), 404, "NOT_FOUND");
    });

    it("uses only the workspace's own key", async () => {
      const [first, second] = [await user(), await user()];
      const none = await person();
      const b = await workbook(second);
      saved(first, 5, contact, 100);
      saved(second, 2);
      apollo.calls.length = 0;
      expect((await imported(second, b.id)).counts.imported).toBe(2);
      expect(apollo.calls.every((c) => c.key === second.key)).toBe(true);
      const theirs = await workbook(none);
      await refused(preview(none, theirs.id), 409, "APOLLO_NOT_CONNECTED");
    });

    it("needs Workbooks V2, but not the CRM feature", async () => {
      const u = await user();
      const b = await workbook(u);
      saved(u, 2);
      await setEntitlement(u.workspaceId, "feature.crm", false);
      expect((await imported(u, b.id)).counts.imported).toBe(2);
      await setEntitlement(u.workspaceId, "feature.workbooks_v2", false);
      expect((await preview(u, b.id)).statusCode).toBe(403);
      expect((await call(u, "GET", `/${b.id}/apollo-source`)).statusCode).toBe(403);
    });

    it("keeps references through a workbook copy, and does not add them again to the copy", async () => {
      const u = await user();
      const b = await workbook(u);
      saved(u, 2);
      await imported(u, b.id);
      const copy = (await call(u, "POST", `/${b.id}/duplicate`, { includeRows: true })).json().data.id as string;
      expect(await refIds(copy)).toEqual(["contact-1", "contact-2"]);
      expect((await imported(u, copy)).counts).toMatchObject({ imported: 0, duplicates: 2 });
    });

    it("can't have its record references set through the Rows API", async () => {
      const u = await user();
      const b = await workbook(u, [{ name: "Who" }]);
      const res = await call(u, "POST", `/${b.id}/rows`, { crmRef: { provider: "apollo", object: "contact", id: "contact-1" } });
      expect(res.statusCode).toBe(422);
      expect(await stored(b.id)).toEqual([]);
    });
  });

  // ── Suppression (WB2-027) ──────────────────────────────────────────────────

  describe("suppression", () => {
    it("imports a suppressed Apollo contact and marks the row", async () => {
      const u = await user();
      const b = await workbook(u);
      saved(u, 3, (i) => ({ ...contact(i), email: `apollo-supp-${i}@example.com` }));
      await db.insert(schema.suppressions).values({ workspaceId: u.workspaceId, email: "apollo-supp-2@example.com" });
      expect((await imported(u, b.id)).counts).toMatchObject({ imported: 3 });
      const rows = await stored(b.id);
      expect(rows.map((r) => r.suppressed)).toEqual([false, true, false]);
      expect(rows[1]!.from).toMatchObject({ type: "apollo" });
    });
  });
});
