import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { invalidateWorkspaceAccess } from "@skout/auth";
import { buildDemoCorpus } from "@skout/opensearch";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { withFailingCellInserts } from "../test/failing-cell-inserts.js";
import { importStorage } from "../services/workbook-import-storage.js";
import { runImportJob } from "../services/workbook-import-runner.js";
import { prospectDirectory } from "../services/prospect-directory.js";
import { addProspectsToWorkbook } from "../services/workbook-prospects.service.js";

/**
 * WB2-021: rows from Skout lists, smart lists and Search, through the real routes against a real database. Search is the
 * local demo index (no OpenSearch). Redis is replaced by a recorder: background jobs are run here by calling what the
 * worker calls.
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
  workbooks, workbookColumns, workbookRows, workbookCells, workbookImports, workbookImportItems, entitlements, auditLogs,
  lists, listMembers, smartLists, prospectActivations, enrichmentJobs, enrichmentResults, emailVerifications, contacts,
  creditBalances, creditTransactions, asyncJobs,
} = schema;

const DEMO = buildDemoCorpus();
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY);
/** Names a provider only the server may know. */
const PROVIDER = "hunter";

interface ImportBody {
  id: string;
  sourceType: string;
  sourceName: string | null;
  truncated: { matched: number; considered: number } | null;
  status: string;
  background: boolean;
  progress: number;
  counts: { total: number; processed: number; imported: number; duplicates: number; skipped: number; failed: number };
  error: { code: string; message: string } | null;
  report: { available: boolean; rows: number };
}

describe.skipIf(!hasDatabase)("Workbooks V2 rows from Skout prospects", () => {
  const { db, sql } = createDb(base.DATABASE_URL!);
  const suffix = Math.random().toString(36).slice(2, 10);
  const config = { ...base, CLERK_SECRET_KEY: undefined, LOG_LEVEL: "fatal" as const, OPENSEARCH_URL: undefined, EARLY_ACCESS_GATE_ENABLED: "true" as never, RATE_LIMIT_MAX: 100_000, PLATFORM_ADMIN_EMAILS: [], EXPORTS_BUCKET: undefined };
  const previousDir = process.env.WORKBOOK_IMPORTS_LOCAL_DIR;
  let dir: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let n = 0;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "wb2-prospects-test-"));
    process.env.WORKBOOK_IMPORTS_LOCAL_DIR = dir;
    app = await buildApp(config);
  });
  beforeEach(() => {
    queue.ready = true;
    queue.jobs.length = 0;
  });
  afterAll(async () => {
    await app.close();
    await sql.end();
    if (previousDir === undefined) delete process.env.WORKBOOK_IMPORTS_LOCAL_DIR;
    else process.env.WORKBOOK_IMPORTS_LOCAL_DIR = previousDir;
    await rm(dir, { recursive: true, force: true });
  });

  // ── People, workbooks and prospects ────────────────────────────────────────

  interface User {
    userId: string;
    workspaceId: string;
    ip: string;
    headers: Record<string, string>;
  }

  async function user(): Promise<User> {
    n += 1;
    const email = `wb2-prospects-${suffix}-${n}@test.com`;
    const ip = `16.${Math.floor(n / 250)}.${n % 250}.7`;
    await app.inject({ method: "GET", url: "/api/v1/me", headers: { "x-stub-user-email": email }, remoteAddress: ip });
    const [u] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
    const [m] = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, u!.id));
    await db.update(schema.workspaces).set({ accessStatus: "active" }).where(eq(schema.workspaces.id, m!.workspaceId));
    await setEntitlement(m!.workspaceId, "feature.workbooks_v2", true);
    return { userId: u!.id, workspaceId: m!.workspaceId, ip, headers: { "x-stub-user-email": email } };
  }

  async function setEntitlement(workspaceId: string, key: string, value: unknown) {
    await db
      .insert(entitlements)
      .values({ workspaceId, key, value, source: "test" })
      .onConflictDoUpdate({ target: [entitlements.workspaceId, entitlements.key], set: { value } });
    invalidateWorkspaceAccess(workspaceId);
  }

  async function colleague(owner: User, permissions: string[]): Promise<User> {
    const other = await user();
    await db.insert(schema.workspaceMembers).values({ workspaceId: owner.workspaceId, userId: other.userId, role: "member" });
    await db.delete(schema.workspaceMemberRoles).where(and(eq(schema.workspaceMemberRoles.workspaceId, owner.workspaceId), eq(schema.workspaceMemberRoles.userId, other.userId)));
    const key = `prospects-${suffix}-${++n}`;
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

  async function workbook(u: User, columns: Array<{ name: string; type?: "input" | "enrichment"; dataType?: string; operation?: string }> = []) {
    const res = await call(u, "POST", "", { name: "Prospects" });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().data.id as string;
    const made = columns.map((c, position) => ({
      id: randomUUID(),
      workbookId: id,
      name: c.name,
      type: c.type ?? ("input" as const),
      operation: c.operation ?? null,
      position,
      config: c.type === "enrichment" ? { inputs: {} } : { dataType: c.dataType ?? "text" },
    }));
    if (made.length) await db.insert(workbookColumns).values(made);
    return { id, col: Object.fromEntries(made.map((c) => [c.name, c.id])) as Record<string, string> };
  }

  interface Person {
    id: string;
    fullName: string;
    domain: string;
  }
  const personId = (tag: string) => createHash("sha256").update(`${suffix}-${tag}`).digest("hex");

  /** People this workspace holds (activated), none of them in the search index. */
  async function people(u: User, count: number, tag = `p${++n}`): Promise<Person[]> {
    const made = Array.from({ length: count }, (_, i) => ({ id: personId(`${tag}-${i}-${u.workspaceId}`), fullName: `${tag} Person ${i}`, domain: `${tag}${i}.com` }));
    for (let i = 0; i < made.length; i += 1_000) {
      await db.insert(prospectActivations).values(
        made.slice(i, i + 1_000).map((p) => ({
          workspaceId: u.workspaceId,
          prospectId: p.id,
          companyId: personId(p.domain),
          snapshot: { prospectId: p.id, fullName: p.fullName, title: "Head of Ops", companyName: `Co ${p.domain}`, companyDomain: p.domain, linkedinUrl: `https://linkedin.com/in/${p.id.slice(0, 12)}` },
        }))
      );
    }
    return made;
  }

  async function list(u: User, members: string[], name = "Target accounts") {
    const [made] = await db.insert(lists).values({ workspaceId: u.workspaceId, name }).returning();
    const start = Date.now() - members.length * 1_000;
    for (let i = 0; i < members.length; i += 1_000) {
      await db.insert(listMembers).values(members.slice(i, i + 1_000).map((prospectId, j) => ({ listId: made!.id, prospectId, addedAt: new Date(start + (i + j) * 1_000) })));
    }
    return made!.id;
  }

  async function smartList(u: User, filters: Record<string, unknown>, name = "ICP") {
    const [made] = await db.insert(smartLists).values({ workspaceId: u.workspaceId, name, filters }).returning();
    return made!.id;
  }

  /** What an enrichment run stored for a person. */
  async function enriched(u: User, prospectId: string, values: { email?: string; status?: string; phone?: string; days?: number; provider?: string }) {
    const at = daysAgo(values.days ?? 1);
    const [job] = await db.insert(enrichmentJobs).values({ workspaceId: u.workspaceId, prospectId, status: "completed", completedAt: at }).returning();
    const row = (fieldName: string, fieldValue: string, extra: Record<string, unknown> = {}) => ({
      enrichmentJobId: job!.id, workspaceId: u.workspaceId, prospectId, fieldName, fieldValue, sourceProvider: values.provider ?? PROVIDER, createdAt: at, ...extra,
    });
    const rows = [
      ...(values.email ? [row("email", values.email)] : []),
      ...(values.status ? [row("email_status", values.status, { validationStatus: values.status, sourceProvider: "millionverifier" })] : []),
      ...(values.phone ? [row("phone", values.phone)] : []),
    ];
    if (rows.length) await db.insert(enrichmentResults).values(rows);
  }

  // ── Adding and reading ─────────────────────────────────────────────────────

  const add = (u: User, workbookId: string, source: unknown, selection: unknown, headers: Record<string, string> = {}) =>
    call(u, "POST", `/${workbookId}/prospect-imports`, { source, selection }, headers);

  async function added(u: User, workbookId: string, source: unknown, selection: unknown): Promise<ImportBody> {
    const res = await add(u, workbookId, source, selection);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.status, res.body).toBe("completed");
    return res.json().data;
  }

  async function status(u: User, workbookId: string, importId: string): Promise<ImportBody> {
    const res = await call(u, "GET", `/${workbookId}/imports/${importId}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data;
  }

  const storage = () => importStorage(config)!;
  const work = (importId: string, lastAttempt = false) => runImportJob(db, storage(), importId, lastAttempt, prospectDirectory(config));

  /** The workbook's rows in order, with each cell by column name. */
  async function stored(workbookId: string) {
    const columns = await db.select().from(workbookColumns).where(eq(workbookColumns.workbookId, workbookId));
    const name = new Map(columns.map((c) => [c.id, c.name]));
    const rows = await db.select().from(workbookRows).where(eq(workbookRows.workbookId, workbookId)).orderBy(asc(workbookRows.position));
    const cells = await db.select().from(workbookCells).where(eq(workbookCells.workbookId, workbookId));
    const byRow = new Map<number, Record<string, (typeof cells)[number]>>();
    for (const c of cells) byRow.set(c.rowId, { ...byRow.get(c.rowId), [name.get(c.columnId)!]: c });
    return rows.map((r) => ({ ...r, cells: byRow.get(r.id) ?? {}, values: Object.fromEntries(Object.entries(byRow.get(r.id) ?? {}).map(([k, c]) => [k, c.value])) }));
  }
  const columnNames = async (workbookId: string) => (await db.select().from(workbookColumns).where(eq(workbookColumns.workbookId, workbookId)).orderBy(asc(workbookColumns.position))).map((c) => c.name);
  const rowCount = async (workbookId: string) => (await db.select({ n: workbooks.rowCount }).from(workbooks).where(eq(workbooks.id, workbookId)))[0]!.n;
  const events = async (workbookId: string) =>
    (await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, workbookId), eq(auditLogs.action, "workbook.rows.added")))).map((e) => e.afterState);
  const report = async (u: User, workbookId: string, importId: string) =>
    (await call(u, "GET", `/${workbookId}/imports/${importId}/report`)).body.replace(/^\uFEFF/, "").trimEnd().split("\r\n");
  /** Everything a provider call or a charge would leave behind. */
  async function spending(workspaceId: string) {
    return {
      balance: await db.select().from(creditBalances).where(eq(creditBalances.workspaceId, workspaceId)),
      ledger: await db.select().from(creditTransactions).where(eq(creditTransactions.workspaceId, workspaceId)),
      jobs: (await db.select({ id: enrichmentJobs.id }).from(enrichmentJobs).where(eq(enrichmentJobs.workspaceId, workspaceId))).length,
      queued: (await db.select({ id: asyncJobs.id }).from(asyncJobs).where(eq(asyncJobs.workspaceId, workspaceId))).length,
    };
  }

  // ── Browsing ───────────────────────────────────────────────────────────────

  describe("browsing a list or smart list", () => {
    it("pages through a list, in the order people joined, marking who is already in the workbook", async () => {
      const u = await user();
      const b = await workbook(u);
      const p = await people(u, 7);
      const id = await list(u, p.map((x) => x.id), "Q4 leads");
      await added(u, b.id, { type: "list", listId: id }, { prospectIds: [p[1]!.id] });
      const first = await call(u, "GET", `/${b.id}/sources/lists/${id}/prospects?pageSize=3`);
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toMatchObject({ source: { type: "list", id, name: "Q4 leads" }, total: 7, page: 1, pageSize: 3 });
      expect(first.json().data).toEqual(
        p.slice(0, 3).map((x, i) => ({ prospectId: x.id, fullName: x.fullName, title: "Head of Ops", companyName: `Co ${x.domain}`, companyDomain: x.domain, inWorkbook: i === 1 }))
      );
      const last = await call(u, "GET", `/${b.id}/sources/lists/${id}/prospects?page=3&pageSize=3`);
      expect(last.json().data.map((d: { prospectId: string }) => d.prospectId)).toEqual([p[6]!.id]);
    });

    it("pages through a smart list's matches without contact details", async () => {
      const u = await user();
      const b = await workbook(u);
      const wanted = DEMO.filter((d) => d.companyDomain === "example1.com");
      const id = await smartList(u, { companyDomain: "example1.com" });
      const res = await call(u, "GET", `/${b.id}/sources/smart-lists/${id}/prospects?pageSize=10`);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().total).toBe(wanted.length);
      expect(res.json().data.map((d: { prospectId: string }) => d.prospectId)).toEqual(wanted.slice(0, 10).map((d) => d.prospectId));
      expect(Object.keys(res.json().data[0]).sort()).toEqual(["companyDomain", "companyName", "fullName", "inWorkbook", "prospectId", "title"]);
      expect(res.body).not.toContain("@example");
      expect(res.body).not.toContain("+1-555");
    });

    it("refuses a page past what search can reach, bad parameters and unknown sources", async () => {
      const u = await user();
      const b = await workbook(u);
      const smart = await smartList(u, {});
      const far = await call(u, "GET", `/${b.id}/sources/smart-lists/${smart}/prospects?page=101&pageSize=100`);
      expect(far.statusCode).toBe(422);
      expect(far.json().code).toBe("PAGE_OUT_OF_RANGE");
      for (const query of ["page=0", "pageSize=101", "page=x", `workspaceId=${u.workspaceId}`]) {
        expect((await call(u, "GET", `/${b.id}/sources/smart-lists/${smart}/prospects?${query}`)).statusCode, query).toBe(422);
      }
      for (const p of [`lists/${MISSING}`, `smart-lists/${MISSING}`, `lists/${smart}`]) {
        expect((await call(u, "GET", `/${b.id}/sources/${p}/prospects`)).statusCode, p).toBe(404);
      }
    });
  });

  // ── From a list ────────────────────────────────────────────────────────────

  describe("adding from a list", () => {
    it("adds every member with their prospect id, where they came from, and their details", async () => {
      const u = await user();
      const b = await workbook(u);
      const p = await people(u, 3, "all");
      const id = await list(u, p.map((x) => x.id), "Everyone");
      const done = await added(u, b.id, { type: "list", listId: id }, { all: true });
      expect(done).toMatchObject({ sourceType: "list", sourceName: "Everyone", background: false, progress: 100, truncated: null, counts: { total: 3, processed: 3, imported: 3, duplicates: 0, skipped: 0, failed: 0 }, report: { available: false } });
      const rows = await stored(b.id);
      expect(rows.map((r) => r.prospectId)).toEqual(p.map((x) => x.id));
      expect(rows[0]!.source).toEqual({ type: "list", listId: id, listName: "Everyone", importId: done.id, addedAt: expect.any(String) });
      expect(rows[0]!.values).toEqual({ "Full name": p[0]!.fullName, Title: "Head of Ops", Company: `Co ${p[0]!.domain}`, "Company domain": p[0]!.domain, "LinkedIn URL": `https://linkedin.com/in/${p[0]!.id.slice(0, 12)}` });
      // No column is made for facts nobody has: there is no email or phone here.
      expect(await columnNames(b.id)).toEqual(["Full name", "Title", "Company", "Company domain", "LinkedIn URL"]);
      expect(Object.values(rows[0]!.cells).every((c) => c.foundVia === null && c.creditsCharged === 0)).toBe(true);
      expect(await rowCount(b.id)).toBe(3);
      expect(await events(b.id)).toEqual([{ source: "list", rows: 3, rowCount: 3 }]);
      expect(await db.select().from(workbookImportItems).where(eq(workbookImportItems.importId, done.id))).toEqual([]);
      // The rows API keeps the link and can filter by where rows came from.
      const read = await call(u, "POST", `/${b.id}/rows/query`, { filters: [{ type: "source", sources: ["list"] }] });
      expect(read.json().data.map((r: { prospectId: string }) => r.prospectId)).toEqual(p.map((x) => x.id));
    });

    it("adds only the people chosen, and reports a chosen person who is not in the list", async () => {
      const u = await user();
      const b = await workbook(u);
      const p = await people(u, 4);
      const id = await list(u, [p[0]!.id, p[1]!.id, p[2]!.id]);
      const done = await added(u, b.id, { type: "list", listId: id }, { prospectIds: [p[2]!.id, p[0]!.id, p[3]!.id, p[0]!.id] });
      expect(done.counts).toMatchObject({ total: 3, imported: 2, skipped: 1 });
      expect((await stored(b.id)).map((r) => r.prospectId)).toEqual([p[2]!.id, p[0]!.id]);
      expect(await report(u, b.id, done.id)).toEqual(['"Position in selection","Result","Reason","Prospect id","Name","Company domain"', `"3","Skipped","Not in this list","${p[3]!.id}","${p[3]!.fullName}","${p[3]!.domain}"`]);
    });

    it("fills the workbook's own columns, whatever they are called, and a find-email column", async () => {
      const u = await user();
      const b = await workbook(u, [
        { name: "Name" },
        { name: "Website", dataType: "url" },
        { name: "Work email", type: "enrichment", operation: "find_email" },
        { name: "Phone number", dataType: "phone" },
        { name: "Employees", dataType: "number" },
      ]);
      const [p] = await people(u, 1);
      await enriched(u, p!.id, { email: "ann@acme.com", status: "valid", phone: "+44 20 7946 0000" });
      await added(u, b.id, { type: "list", listId: await list(u, [p!.id]) }, { all: true });
      expect(await columnNames(b.id)).toEqual(["Name", "Website", "Work email", "Phone number", "Employees", "Title", "Company", "LinkedIn URL"]);
      const [row] = await stored(b.id);
      expect(row!.values).toMatchObject({ Name: p!.fullName, "Work email": "ann@acme.com", "Phone number": "+44 20 7946 0000" });
      // A domain in a web-address column is kept and marked, as if it had been typed there.
      expect(row!.cells.Website).toMatchObject({ value: p!.domain, state: "error", errorCode: "invalid_url" });
      expect(row!.cells["Work email"]).toMatchObject({ state: "found", foundVia: "cache", verification: "valid", creditsCharged: 0 });
    });

    it("names a new column differently when the name is taken by a column that cannot hold the value", async () => {
      const u = await user();
      const b = await workbook(u, [{ name: "Title", dataType: "number" }]);
      const [p] = await people(u, 1);
      await added(u, b.id, { type: "list", listId: await list(u, [p!.id]) }, { all: true });
      expect(await columnNames(b.id)).toContain("Title (2)");
      expect((await stored(b.id))[0]!.values["Title (2)"]).toBe("Head of Ops");
    });

    it("takes the names of members it only knows by id from the search index, and activates them once", async () => {
      const u = await user();
      const b = await workbook(u);
      const [indexed, unknown] = [DEMO[10]!, personId("nobody")];
      const id = await list(u, [indexed.prospectId, unknown]);
      const done = await added(u, b.id, { type: "list", listId: id }, { all: true });
      expect(done.counts).toMatchObject({ imported: 1, skipped: 1 });
      expect((await stored(b.id))[0]!.values["Full name"]).toBe(indexed.fullName);
      const activations = await db.select().from(prospectActivations).where(eq(prospectActivations.workspaceId, u.workspaceId));
      expect(activations.map((a) => a.prospectId)).toEqual([indexed.prospectId]);
      expect(activations[0]!.snapshot).not.toHaveProperty("email");
    });
  });

  // ── Reusing stored enrichment ──────────────────────────────────────────────

  describe("stored enrichment", () => {
    it("is copied as From your Skout data, free, with nothing looked up or spent", async () => {
      const u = await user();
      const b = await workbook(u);
      await db.insert(creditBalances).values({ workspaceId: u.workspaceId, balance: 500 }).onConflictDoNothing();
      const p = await people(u, 2);
      await enriched(u, p[0]!.id, { email: "a@acme.com", status: "valid", phone: "+1 555 010 9999" });
      await enriched(u, p[1]!.id, { email: "b@acme.com", status: "catch_all", days: 29 });
      const before = await spending(u.workspaceId);
      const fetched = vi.spyOn(globalThis, "fetch");
      const res = await add(u, b.id, { type: "list", listId: await list(u, p.map((x) => x.id)) }, { all: true });
      expect(fetched).not.toHaveBeenCalled();
      fetched.mockRestore();
      expect(await spending(u.workspaceId)).toEqual(before);
      const rows = await stored(b.id);
      expect(rows[0]!.cells.Email).toMatchObject({ value: "a@acme.com", state: "found", foundVia: "cache", verification: "valid", creditsCharged: 0 });
      expect(rows[0]!.cells.Phone).toMatchObject({ value: "+1 555 010 9999", foundVia: "cache", verification: null, creditsCharged: 0 });
      expect(rows[1]!.cells.Email).toMatchObject({ foundVia: "cache", verification: "catch_all" });
      expect(rows[1]!.cells.Phone).toBeUndefined();
      // The provider is remembered on the server and named to nobody.
      expect(rows[0]!.cells.Email!.internalProvenance).toMatchObject({ reused: true, provider: PROVIDER });
      const shown = await call(u, "GET", `/${b.id}/rows`);
      expect(shown.json().data[0].cells[rows[0]!.cells.Email!.columnId]).toMatchObject({ value: "a@acme.com", foundVia: "cache", verification: "valid", creditsCharged: 0 });
      for (const body of [shown.body, res.body, (await call(u, "GET", `/${b.id}`)).body, (await call(u, "GET", `/${b.id}/activity`)).body, (await call(u, "GET", `/${b.id}/imports`)).body]) {
        expect(body.toLowerCase()).not.toMatch(/hunter|millionverifier|internalprovenance|internal_provenance/);
      }
    });

    it.each<[string, (u: User, id: string) => Promise<unknown>]>([
      ["found more than 30 days ago", (u, id) => enriched(u, id, { email: "x@acme.com", status: "valid", phone: "+1 555 010 1111", days: 31 })],
      ["verified as invalid", (u, id) => enriched(u, id, { email: "x@acme.com", status: "invalid" })],
      ["only a provider's sample", (u, id) => enriched(u, id, { email: "x@acme.com", phone: "+1 555 010 1111", provider: "stub-provider" })],
      ["found by another workspace", async (_u, id) => enriched(await user(), id, { email: "x@acme.com", status: "valid", phone: "+1 555 010 1111" })],
      [
        "on a CRM record with no date, however recently the record was edited",
        (u, id) => db.insert(contacts).values({ workspaceId: u.workspaceId, firstName: "A", sourceProspectId: id, email: "x@acme.com", phone: "+1 555 010 1111", updatedAt: new Date() }),
      ],
      [
        "on a CRM record dated long ago",
        (u, id) => db.insert(contacts).values({ workspaceId: u.workspaceId, firstName: "A", sourceProspectId: id, email: "x@acme.com", fieldSources: { email: { source: "manual", setAt: daysAgo(40).toISOString() } } }),
      ],
      [
        "on a deleted CRM record",
        (u, id) => db.insert(contacts).values({ workspaceId: u.workspaceId, firstName: "A", sourceProspectId: id, email: "x@acme.com", deletedAt: new Date(), fieldSources: { email: { source: "manual", setAt: daysAgo(1).toISOString() } } }),
      ],
    ])("is not copied when %s", async (_name, arrange) => {
      const u = await user();
      const b = await workbook(u);
      const [p] = await people(u, 1);
      await arrange(u, p!.id);
      await added(u, b.id, { type: "list", listId: await list(u, [p!.id]) }, { all: true });
      const [row] = await stored(b.id);
      expect(row!.values["Full name"]).toBe(p!.fullName);
      expect(row!.values).not.toHaveProperty("Email");
      expect(row!.values).not.toHaveProperty("Phone");
    });

    it("includes a value verified recently though found long ago, and a recently dated CRM value", async () => {
      const u = await user();
      const b = await workbook(u);
      const p = await people(u, 2);
      await enriched(u, p[0]!.id, { email: "old@acme.com", days: 200 });
      await db.insert(emailVerifications).values({ workspaceId: u.workspaceId, prospectId: p[0]!.id, email: "OLD@acme.com", status: "valid", provider: "millionverifier", verifiedAt: daysAgo(2) });
      await db.insert(contacts).values({ workspaceId: u.workspaceId, firstName: "B", sourceProspectId: p[1]!.id, phone: "+1 555 010 2222", fieldSources: { phone: { source: "manual", setAt: daysAgo(3).toISOString() } } });
      await added(u, b.id, { type: "list", listId: await list(u, p.map((x) => x.id)) }, { all: true });
      const rows = await stored(b.id);
      expect(rows[0]!.cells.Email).toMatchObject({ value: "old@acme.com", verification: "valid", foundVia: "cache" });
      expect(rows[1]!.cells.Phone).toMatchObject({ value: "+1 555 010 2222", foundVia: "cache" });
    });

    it("leaves out an email the stored verdict has since marked invalid", async () => {
      const u = await user();
      const b = await workbook(u);
      const [p] = await people(u, 1);
      await enriched(u, p!.id, { email: "gone@acme.com", status: "valid", days: 10 });
      await db.insert(emailVerifications).values({ workspaceId: u.workspaceId, prospectId: p!.id, email: "gone@acme.com", status: "invalid", provider: "millionverifier", verifiedAt: daysAgo(1) });
      await added(u, b.id, { type: "list", listId: await list(u, [p!.id]) }, { all: true });
      expect((await stored(b.id))[0]!.values).not.toHaveProperty("Email");
    });

    it("loses the label once a person edits the cell, and keeps it and the link on a copy", async () => {
      const u = await user();
      const b = await workbook(u);
      const [p] = await people(u, 1);
      await enriched(u, p!.id, { email: "a@acme.com", status: "valid" });
      await added(u, b.id, { type: "list", listId: await list(u, [p!.id]) }, { all: true });
      const copy = await call(u, "POST", `/${b.id}/duplicate`, { includeRows: true });
      expect((await stored(copy.json().data.id))[0]).toMatchObject({ prospectId: p!.id, cells: { Email: { foundVia: "cache", verification: "valid" } } });
      const [row] = await stored(b.id);
      const edited = await call(u, "PATCH", `/${b.id}/rows/${row!.id}`, { cells: { [row!.cells.Email!.columnId]: "typed@acme.com" } });
      expect(edited.statusCode, edited.body).toBe(200);
      expect(edited.json().data.prospectId).toBe(p!.id);
      expect(edited.json().data.cells[row!.cells.Email!.columnId]).toMatchObject({ value: "typed@acme.com", foundVia: null, verification: null });
    });
  });

  // ── From Search ────────────────────────────────────────────────────────────

  describe("adding from Search", () => {
    it("adds the chosen people from the search index, without the index's contact details", async () => {
      const u = await user();
      const b = await workbook(u);
      // Index documents 1 and 4 carry an email and a phone that nobody verified.
      const chosen = [DEMO[4]!, DEMO[1]!];
      const done = await added(u, b.id, { type: "search" }, { prospectIds: chosen.map((d) => d.prospectId) });
      expect(done).toMatchObject({ sourceType: "search", sourceName: null, counts: { total: 2, imported: 2 } });
      const rows = await stored(b.id);
      expect(rows.map((r) => r.prospectId)).toEqual(chosen.map((d) => d.prospectId));
      expect(rows[0]!.source).toEqual({ type: "search", importId: done.id, addedAt: expect.any(String) });
      expect(rows[0]!.values).toMatchObject({ "Full name": chosen[0]!.fullName, "Company domain": chosen[0]!.companyDomain });
      expect(rows[0]!.values).not.toHaveProperty("Email");
      expect(JSON.stringify(rows)).not.toContain(chosen[0]!.email!);
      expect(await events(b.id)).toEqual([{ source: "search", rows: 2, rowCount: 2 }]);
    });

    it("leaves a prospect the workspace already holds as it was, and never makes a second one", async () => {
      const u = await user();
      const doc = DEMO[20]!;
      await db.insert(prospectActivations).values({ workspaceId: u.workspaceId, prospectId: doc.prospectId, companyId: doc.companyId, snapshot: { fullName: "Our own spelling" } });
      const first = await workbook(u);
      const second = await workbook(u);
      for (const b of [first, second]) await added(u, b.id, { type: "search" }, { prospectIds: [doc.prospectId, DEMO[21]!.prospectId] });
      const activations = await db.select().from(prospectActivations).where(eq(prospectActivations.workspaceId, u.workspaceId));
      expect(activations).toHaveLength(2);
      expect(activations.find((a) => a.prospectId === doc.prospectId)!.snapshot).toEqual({ fullName: "Our own spelling" });
      expect((await stored(second.id))[0]!.values["Full name"]).toBe("Our own spelling");
    });

    it("answers another workspace's own prospect exactly like one that does not exist", async () => {
      const [u, other] = [await user(), await user()];
      const b = await workbook(u);
      const [theirs] = await people(other, 1, "secret");
      await enriched(other, theirs!.id, { email: "secret@their.com", status: "valid" });
      const done = await added(u, b.id, { type: "search" }, { prospectIds: [theirs!.id, personId("made-up")] });
      expect(done.counts).toMatchObject({ imported: 0, skipped: 2 });
      const lines = await report(u, b.id, done.id);
      expect(lines.slice(1)).toEqual([`"1","Skipped","Prospect not found","${theirs!.id}","",""`, `"2","Skipped","Prospect not found","${personId("made-up")}","",""`]);
      expect(await stored(b.id)).toEqual([]);
      expect(await db.select().from(prospectActivations).where(eq(prospectActivations.workspaceId, u.workspaceId))).toEqual([]);
      expect(await columnNames(b.id)).toEqual([]);
    });
  });

  // ── From a smart list ──────────────────────────────────────────────────────

  describe("adding from a smart list", () => {
    it("adds everyone who matches, naming the smart list on each row", async () => {
      const u = await user();
      const b = await workbook(u);
      const wanted = DEMO.filter((d) => d.companyDomain === "example2.com");
      const id = await smartList(u, { companyDomain: "example2.com" }, "Example 2 people");
      const done = await added(u, b.id, { type: "smart_list", smartListId: id }, { all: true });
      expect(done).toMatchObject({ sourceType: "smart_list", sourceName: "Example 2 people", truncated: null, counts: { total: wanted.length, imported: wanted.length } });
      const rows = await stored(b.id);
      expect(rows.map((r) => r.prospectId)).toEqual(wanted.map((d) => d.prospectId));
      expect(rows[0]!.source).toMatchObject({ type: "smart_list", smartListId: id, smartListName: "Example 2 people" });
    });

    it("adds the people chosen, refusing any who do not match it", async () => {
      const u = await user();
      const b = await workbook(u);
      const id = await smartList(u, { companyDomain: "example2.com" });
      const [inside, outside] = [DEMO.find((d) => d.companyDomain === "example2.com")!, DEMO.find((d) => d.companyDomain === "example3.com")!];
      const done = await added(u, b.id, { type: "smart_list", smartListId: id }, { prospectIds: [inside.prospectId, outside.prospectId] });
      expect(done.counts).toMatchObject({ imported: 1, skipped: 1 });
      expect((await report(u, b.id, done.id))[1]).toContain('"Does not match this smart list"');
    });

    it("reads a large smart list in the background and adds all of it", async () => {
      const u = await user();
      const b = await workbook(u);
      const id = await smartList(u, {});
      const res = await add(u, b.id, { type: "smart_list", smartListId: id }, { all: true });
      expect(res.statusCode, res.body).toBe(202);
      const started = res.json().data as ImportBody;
      expect(started).toMatchObject({ status: "queued", background: true, counts: { total: 0, processed: 0 } });
      expect(queue.jobs).toEqual([{ importId: started.id, workspaceId: u.workspaceId }]);
      await work(started.id);
      expect(await status(u, b.id, started.id)).toMatchObject({ status: "completed", progress: 100, counts: { total: DEMO.length, processed: DEMO.length, imported: DEMO.length } });
      expect(await rowCount(b.id)).toBe(DEMO.length);
      const [distinct] = await sql`select count(distinct prospect_id)::int as n from workbook_rows where workbook_id = ${b.id}`;
      expect(distinct!.n).toBe(DEMO.length);
      expect(await events(b.id)).toEqual([{ source: "smart_list", rows: DEMO.length, rowCount: DEMO.length }]);
    });

    it("considers only as many as the workbook can hold, and says so", async () => {
      const u = await user();
      await setEntitlement(u.workspaceId, "workbooks.row_limit", 50);
      const b = await workbook(u);
      const res = await add(u, b.id, { type: "smart_list", smartListId: await smartList(u, {}) }, { all: true });
      expect(res.statusCode, res.body).toBe(202);
      await work(res.json().data.id);
      expect(await status(u, b.id, res.json().data.id)).toMatchObject({ truncated: { matched: DEMO.length, considered: 50 }, counts: { total: 50, imported: 50 } });
    });

    it("refuses a smart list that matches nobody", async () => {
      const u = await user();
      const b = await workbook(u);
      const res = await add(u, b.id, { type: "smart_list", smartListId: await smartList(u, { companyDomain: "nobody.invalid" }) }, { all: true });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe("NOTHING_TO_ADD");
    });
  });

  // ── Duplicates, retries and limits ─────────────────────────────────────────

  describe("adding again", () => {
    it("never adds a prospect twice, whichever way they arrive", async () => {
      const u = await user();
      const b = await workbook(u);
      const inList = [DEMO[30]!.prospectId, DEMO[31]!.prospectId];
      const id = await list(u, inList);
      await added(u, b.id, { type: "list", listId: id }, { all: true });
      const again = await added(u, b.id, { type: "list", listId: id }, { all: true });
      expect(again.counts).toMatchObject({ imported: 0, duplicates: 2 });
      const search = await added(u, b.id, { type: "search" }, { prospectIds: [inList[0]!, DEMO[32]!.prospectId] });
      expect(search.counts).toMatchObject({ imported: 1, duplicates: 1 });
      expect((await report(u, b.id, search.id))[1]).toContain('"Duplicate","Already in this workbook"');
      expect((await stored(b.id)).map((r) => r.prospectId)).toEqual([...inList, DEMO[32]!.prospectId]);
      expect(await events(b.id)).toHaveLength(2);
    });

    it("keeps simultaneous additions of the same people from doubling them", async () => {
      const u = await user();
      const b = await workbook(u);
      const ids = DEMO.slice(100, 700).map((d) => d.prospectId);
      const all = await Promise.all([1, 2, 3].map(() => added(u, b.id, { type: "search" }, { prospectIds: ids })));
      expect(all.reduce((sum, a) => sum + a.counts.imported, 0)).toBe(600);
      expect(all.reduce((sum, a) => sum + a.counts.duplicates, 0)).toBe(1_200);
      expect(await rowCount(b.id)).toBe(600);
    });

    it("starts one addition however many times a keyed request is sent", async () => {
      const u = await user();
      const b = await workbook(u);
      const key = { "idempotency-key": `add-${randomUUID()}` };
      const send = () => add(u, b.id, { type: "search" }, { prospectIds: [DEMO[40]!.prospectId] }, key);
      const [first, second] = [await send(), await send()];
      expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
      expect(second.json().data.id).toBe(first.json().data.id);
      expect(await db.select().from(workbookImports).where(eq(workbookImports.workbookId, b.id))).toHaveLength(1);
    });

    it("adds up to the row limit and reports the rest; a full workbook is refused", async () => {
      const u = await user();
      await setEntitlement(u.workspaceId, "workbooks.row_limit", 3);
      const b = await workbook(u);
      const p = await people(u, 5);
      const id = await list(u, p.map((x) => x.id));
      const done = await added(u, b.id, { type: "list", listId: id }, { prospectIds: p.map((x) => x.id) });
      expect(done.counts).toMatchObject({ imported: 3, failed: 2 });
      expect((await report(u, b.id, done.id))[1]).toContain('"Over the row limit"');
      const full = await add(u, b.id, { type: "list", listId: id }, { all: true });
      expect(full.statusCode).toBe(422);
      expect(full.json().code).toBe("ROW_LIMIT_EXCEEDED");
      expect(await rowCount(b.id)).toBe(3);
    });

    it("says how many of a list were considered when it is larger than a workbook", async () => {
      const u = await user();
      await setEntitlement(u.workspaceId, "workbooks.row_limit", 3);
      const b = await workbook(u);
      const p = await people(u, 5);
      const done = await added(u, b.id, { type: "list", listId: await list(u, p.map((x) => x.id)) }, { all: true });
      expect(done).toMatchObject({ truncated: { matched: 5, considered: 3 }, counts: { total: 3, imported: 3 } });
    });
  });

  // ── Large and interrupted additions ────────────────────────────────────────

  describe("large additions", () => {
    async function queued(u: User, workbookId: string, listId: string) {
      const res = await add(u, workbookId, { type: "list", listId }, { all: true });
      expect(res.statusCode, res.body).toBe(202);
      return res.json().data.id as string;
    }

    it("resumes after a failure with real progress and nobody added twice", async () => {
      const u = await user();
      const b = await workbook(u);
      const p = await people(u, 1_600, "big");
      const boom = `boom-${suffix}`;
      await db.update(prospectActivations).set({ snapshot: { fullName: boom } }).where(and(eq(prospectActivations.workspaceId, u.workspaceId), eq(prospectActivations.prospectId, p[1_200]!.id)));
      const id = await queued(u, b.id, await list(u, p.map((x) => x.id)));
      expect(await status(u, b.id, id)).toMatchObject({ status: "queued", progress: 0, counts: { total: 1_600 } });
      await withFailingCellInserts(sql, `wb2_prospect_boom_${suffix}`, `new.value = '"${boom}"'::jsonb`, () => expect(work(id)).rejects.toThrow(/could not be processed/));
      expect(await status(u, b.id, id)).toMatchObject({ status: "processing", progress: 62, counts: { processed: 1_000, imported: 1_000 } });
      expect(await rowCount(b.id)).toBe(1_000);
      await work(id);
      await work(id);
      expect(await status(u, b.id, id)).toMatchObject({ status: "completed", counts: { processed: 1_600, imported: 1_600, duplicates: 0 } });
      expect((await stored(b.id)).map((r) => r.prospectId)).toEqual(p.map((x) => x.id));
      expect(await events(b.id)).toHaveLength(1);
    });

    it("adds each person once when two workers run it", async () => {
      const u = await user();
      const b = await workbook(u);
      const p = await people(u, 1_100);
      const id = await queued(u, b.id, await list(u, p.map((x) => x.id)));
      await Promise.all([work(id), work(id)]);
      expect(await rowCount(b.id)).toBe(1_100);
      expect((await status(u, b.id, id)).counts).toMatchObject({ imported: 1_100, duplicates: 0 });
    });

    it("keeps to the list as it was, and skips someone removed from it before their turn", async () => {
      const u = await user();
      const b = await workbook(u);
      const p = await people(u, 1_002);
      const listId = await list(u, p.slice(0, 1_001).map((x) => x.id));
      const id = await queued(u, b.id, listId);
      await db.delete(listMembers).where(and(eq(listMembers.listId, listId), eq(listMembers.prospectId, p[5]!.id)));
      await db.insert(listMembers).values({ listId, prospectId: p[1_001]!.id });
      await work(id);
      expect((await status(u, b.id, id)).counts).toMatchObject({ total: 1_001, imported: 1_000, skipped: 1 });
      expect((await stored(b.id)).map((r) => r.prospectId)).not.toContain(p[1_001]!.id);
    });

    it("is marked failed after the last attempt, keeping what was added", async () => {
      const u = await user();
      const b = await workbook(u);
      const p = await people(u, 1_100);
      const boom = `boom2-${suffix}`;
      await db.update(prospectActivations).set({ snapshot: { fullName: boom } }).where(and(eq(prospectActivations.workspaceId, u.workspaceId), eq(prospectActivations.prospectId, p[700]!.id)));
      const id = await queued(u, b.id, await list(u, p.map((x) => x.id)));
      await withFailingCellInserts(sql, `wb2_prospect_boom2_${suffix}`, `new.value = '"${boom}"'::jsonb`, () => expect(work(id, true)).rejects.toThrow());
      expect(await status(u, b.id, id)).toMatchObject({ status: "failed", error: { code: "IMPORT_FAILED" }, counts: { imported: 500 } });
      expect(await events(b.id)).toEqual([{ source: "list", rows: 500, rowCount: 500 }]);
      expect(await db.select().from(workbookImportItems).where(eq(workbookImportItems.importId, id))).toEqual([]);
    });

    it.each<[string, (b: { id: string; col: Record<string, string> }) => Promise<unknown>, string]>([
      ["the workbook was deleted", (b) => db.update(workbooks).set({ deletedAt: new Date() }).where(eq(workbooks.id, b.id)), "WORKBOOK_DELETED"],
    ])("fails without retrying when %s", async (_name, change, code) => {
      const u = await user();
      const b = await workbook(u);
      const p = await people(u, 1_001);
      const id = await queued(u, b.id, await list(u, p.map((x) => x.id)));
      await change(b);
      await work(id);
      expect((await db.select().from(workbookImports).where(eq(workbookImports.id, id)))[0]).toMatchObject({ status: "failed", error: { code } });
    });

    it("stops when a column it was filling is deleted part way", async () => {
      const u = await user();
      const b = await workbook(u, [{ name: "Name" }]);
      const p = await people(u, 1_100);
      const boom = `boom3-${suffix}`;
      await db.update(prospectActivations).set({ snapshot: { fullName: boom } }).where(and(eq(prospectActivations.workspaceId, u.workspaceId), eq(prospectActivations.prospectId, p[700]!.id)));
      const id = await queued(u, b.id, await list(u, p.map((x) => x.id)));
      await withFailingCellInserts(sql, `wb2_prospect_boom3_${suffix}`, `new.value = '"${boom}"'::jsonb`, () => expect(work(id)).rejects.toThrow());
      await db.delete(workbookColumns).where(eq(workbookColumns.id, b.col.Name!));
      await work(id);
      expect(await status(u, b.id, id)).toMatchObject({ status: "failed", error: { code: "MAPPING_CHANGED" }, counts: { imported: 500 } });
    });

    it("changes nothing when background work cannot be queued", async () => {
      const u = await user();
      const b = await workbook(u);
      const p = await people(u, 1_001);
      queue.ready = false;
      const res = await add(u, b.id, { type: "list", listId: await list(u, p.map((x) => x.id)) }, { all: true });
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe("IMPORT_UNAVAILABLE");
      expect(await db.select().from(workbookImports).where(eq(workbookImports.workbookId, b.id))).toEqual([]);
    });
  });

  // ── Who may do what ────────────────────────────────────────────────────────

  describe("access", () => {
    it("lets a viewer browse and nothing else", async () => {
      const owner = await user();
      const b = await workbook(owner);
      const id = await list(owner, (await people(owner, 1)).map((x) => x.id));
      const viewer = await colleague(owner, ["enrichment:read"]);
      expect((await call(viewer, "GET", `/${b.id}/sources/lists/${id}/prospects`)).statusCode).toBe(200);
      expect((await add(viewer, b.id, { type: "list", listId: id }, { all: true })).statusCode).toBe(403);
      const nobody = await colleague(owner, []);
      expect((await call(nobody, "GET", `/${b.id}/sources/lists/${id}/prospects`)).statusCode).toBe(403);
      expect(await stored(b.id)).toEqual([]);
    });

    it("treats another workspace's workbook, list and smart list as not there", async () => {
      const [u, other] = [await user(), await user()];
      const [mine, theirs] = [await workbook(u), await workbook(other)];
      const theirList = await list(other, (await people(other, 2)).map((x) => x.id));
      const theirSmart = await smartList(other, {});
      for (const res of [
        await add(u, theirs.id, { type: "search" }, { prospectIds: [DEMO[0]!.prospectId] }),
        await call(u, "GET", `/${theirs.id}/sources/lists/${theirList}/prospects`),
        await call(u, "GET", `/${mine.id}/sources/lists/${theirList}/prospects`),
        await call(u, "GET", `/${mine.id}/sources/smart-lists/${theirSmart}/prospects`),
      ]) {
        expect(res.statusCode, res.body).toBe(404);
      }
      for (const [source, ghost] of [
        [{ type: "list", listId: theirList }, { type: "list", listId: MISSING }],
        [{ type: "smart_list", smartListId: theirSmart }, { type: "smart_list", smartListId: MISSING }],
      ]) {
        const real = await add(u, mine.id, source, { all: true });
        const madeUp = await add(u, mine.id, ghost, { all: true });
        expect([real.statusCode, real.json().code, real.json().message]).toEqual([422, "UNKNOWN_SOURCE", madeUp.json().message]);
      }
      expect(await stored(mine.id)).toEqual([]);
      expect(await stored(theirs.id)).toEqual([]);
    });

    it.each<[string, unknown]>([
      ["all of Search", { source: { type: "search" }, selection: { all: true } }],
      ["nobody", { source: { type: "search" }, selection: { prospectIds: [] } }],
      ["more than 10,000 people", { source: { type: "search" }, selection: { prospectIds: Array.from({ length: 10_001 }, (_, i) => `p${i}`) } }],
      ["both a choice and all", { source: { type: "search" }, selection: { prospectIds: ["a"], all: true } }],
      ["an unknown source", { source: { type: "crm" }, selection: { all: true } }],
      ["a list without its id", { source: { type: "list" }, selection: { all: true } }],
      ["a workspace id", { source: { type: "search" }, selection: { prospectIds: ["a"] }, workspaceId: MISSING }],
      ["a workspace id in the source", { source: { type: "search", workspaceId: MISSING }, selection: { prospectIds: ["a"] } }],
    ])("refuses a request for %s", async (_name, body) => {
      const u = await user();
      const b = await workbook(u);
      const res = await call(u, "POST", `/${b.id}/prospect-imports`, body);
      expect(res.statusCode, res.body).toBe(422);
      expect(await db.select().from(workbookImports).where(eq(workbookImports.workbookId, b.id))).toEqual([]);
    });

    it("lists additions with the imports, and does not let one be confirmed or cancelled", async () => {
      const u = await user();
      const b = await workbook(u);
      const done = await added(u, b.id, { type: "search" }, { prospectIds: [DEMO[50]!.prospectId] });
      const listed = await call(u, "GET", `/${b.id}/imports`);
      expect(listed.json().data).toMatchObject([{ id: done.id, sourceType: "search", status: "completed" }]);
      expect((await call(u, "POST", `/${b.id}/imports/${done.id}/confirm`, { columns: [], dedupe: { key: "none" } })).statusCode).toBe(409);
      expect((await call(u, "DELETE", `/${b.id}/imports/${done.id}`)).statusCode).toBe(409);
    });

    it("uses no demo people in production without a search index", async () => {
      const u = await user();
      const b = await workbook(u);
      const production = prospectDirectory({ ...config, NODE_ENV: "production" });
      expect(production.available).toBe(false);
      expect(await production.byIds([DEMO[0]!.prospectId])).toEqual(new Map());
      const deps = { storage: storage(), queue: { ready: async () => true, enqueue: async () => {} }, directory: production };
      const actor = { workspaceId: u.workspaceId, userId: u.userId };
      await expect(addProspectsToWorkbook(db, deps, actor, b.id, { source: { type: "search" }, selection: { prospectIds: [DEMO[0]!.prospectId] } })).rejects.toMatchObject({ code: "SEARCH_UNAVAILABLE" });
      // A list still works from what the workspace holds.
      const [p] = await people(u, 1);
      const result = await addProspectsToWorkbook(db, deps, actor, b.id, { source: { type: "list", listId: await list(u, [p!.id, DEMO[0]!.prospectId]) }, selection: { all: true } });
      expect(result.data.counts).toMatchObject({ imported: 1, skipped: 1 });
    });
  });
});
