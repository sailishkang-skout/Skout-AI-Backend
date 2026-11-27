import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { invalidateWorkspaceAccess } from "@skout/auth";
import { bulkUpsertProspects, ensureProspectsIndex, type ProspectDocument } from "@skout/opensearch";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { importStorage } from "../services/workbook-import-storage.js";
import { runImportJob } from "../services/workbook-import-runner.js";
import { prospectDirectory } from "../services/prospect-directory.js";

/**
 * WB2-021 against a real search index, with both ways its prospect ids can be mapped.
 *
 * Skipped unless pointed at a search server that is safe to fill and empty:
 *   WORKBOOK_TEST_OPENSEARCH_URL=http://localhost:59200 DATABASE_URL=postgresql://... \
 *     npx vitest run src/routes/workbook-v2-prospects.search.test.ts
 */
const queue = vi.hoisted(() => ({ jobs: [] as Array<{ importId: string }> }));
vi.mock("../workers/workbook-import.queue.js", () => ({
  workbookImportQueue: () => ({ ready: async () => true, enqueue: async (job: { importId: string }) => void queue.jobs.push(job) }),
  closeWorkbookImportQueue: async () => {},
}));

const base = loadEnv();
const searchUrl = process.env.WORKBOOK_TEST_OPENSEARCH_URL;
/** More than the 10,000 results numbered paging can reach. */
const MANY = 12_500;

describe.skipIf(!searchUrl || !base.DATABASE_URL).each(["created by Skout", "mapped dynamically"] as const)("rows from a search index %s", (mapping) => {
  const { db, sql } = createDb(base.DATABASE_URL!);
  const letters = Array.from({ length: 8 }, () => "abcdefghij"[Math.floor(Math.random() * 10)]).join("");
  const index = `wb2021-${letters}`;
  const domain = `bulk${letters}.com`;
  const config = { ...base, CLERK_SECRET_KEY: undefined, LOG_LEVEL: "fatal" as const, OPENSEARCH_URL: searchUrl!, OPENSEARCH_INDEX: index, OPENSEARCH_USERNAME: undefined, OPENSEARCH_PASSWORD: undefined, EXPORTS_BUCKET: undefined, RATE_LIMIT_MAX: 10_000 };
  const cfg = { url: searchUrl!, index };
  const email = `wb2-search-${letters}@test.com`;
  const previousDir = process.env.WORKBOOK_IMPORTS_LOCAL_DIR;
  let dir: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let workspaceId: string;

  const id = (i: number) => createHash("sha256").update(`${letters}-${i}`).digest("hex");
  const document = (i: number, companyDomain = domain): ProspectDocument => ({
    prospectId: id(i),
    companyId: id(-1),
    fullName: `Indexed Person ${i}`,
    title: "Analyst",
    companyDomain,
    companyName: "Bulk",
    email: `unverified${i}@${companyDomain}`,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  beforeAll(async () => {
    if (mapping === "created by Skout") await ensureProspectsIndex(cfg);
    const docs = [...Array.from({ length: MANY }, (_, i) => document(i)), document(MANY, "elsewhere.com")];
    for (let i = 0; i < docs.length; i += 2_000) expect((await bulkUpsertProspects(cfg, docs.slice(i, i + 2_000))).failed).toBe(0);
    await fetch(`${searchUrl}/${index}/_refresh`, { method: "POST" });
    const mapped = (await (await fetch(`${searchUrl}/${index}/_mapping`)).json()) as Record<string, { mappings: { properties: { prospectId: { type: string } } } }>;
    expect(mapped[index]!.mappings.properties.prospectId.type).toBe(mapping === "created by Skout" ? "keyword" : "text");

    dir = await mkdtemp(path.join(os.tmpdir(), "wb2-search-test-"));
    process.env.WORKBOOK_IMPORTS_LOCAL_DIR = dir;
    app = await buildApp(config);
    await app.inject({ method: "GET", url: "/api/v1/me", headers: { "x-stub-user-email": email } });
    const [u] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
    const [m] = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, u!.id));
    workspaceId = m!.workspaceId;
    await db.update(schema.workspaces).set({ accessStatus: "active" }).where(eq(schema.workspaces.id, workspaceId));
    await db.insert(schema.entitlements).values({ workspaceId, key: "feature.workbooks_v2", value: true, source: "test" });
    invalidateWorkspaceAccess(workspaceId);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await sql.end();
    await fetch(`${searchUrl}/${index}`, { method: "DELETE" });
    if (previousDir === undefined) delete process.env.WORKBOOK_IMPORTS_LOCAL_DIR;
    else process.env.WORKBOOK_IMPORTS_LOCAL_DIR = previousDir;
    await rm(dir, { recursive: true, force: true });
  });

  const call = (method: "GET" | "POST", p: string, body?: unknown) =>
    app.inject({ method, url: `/api/v1/workbooks-v2${p}`, headers: { "x-stub-user-email": email, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { payload: JSON.stringify(body) } : {}) });
  const workbook = async () => (await call("POST", "", { name: "Search" })).json().data.id as string;
  const smartList = async (filters: Record<string, unknown>) =>
    (await db.insert(schema.smartLists).values({ workspaceId, name: "Bulk", filters }).returning())[0]!.id;

  it("pages through matches without repeating or missing anyone", async () => {
    const wb = await workbook();
    const list = await smartList({ companyDomain: domain });
    const seen = new Set<string>();
    for (const page of [1, 2, 3]) {
      const res = await call("GET", `/${wb}/sources/smart-lists/${list}/prospects?page=${page}&pageSize=100`);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().total).toBe(MANY);
      for (const p of res.json().data) seen.add(p.prospectId);
    }
    expect(seen.size).toBe(300);
  });

  it("adds every match of a smart list, past the 10,000-result window", async () => {
    const wb = await workbook();
    const res = await call("POST", `/${wb}/prospect-imports`, { source: { type: "smart_list", smartListId: await smartList({ companyDomain: domain }) }, selection: { all: true } });
    expect(res.statusCode, res.body).toBe(202);
    await runImportJob(db, importStorage(config)!, res.json().data.id, true, prospectDirectory(config));
    const done = (await call("GET", `/${wb}/imports/${res.json().data.id}`)).json().data;
    expect(done).toMatchObject({ status: "completed", truncated: null, counts: { total: MANY, imported: MANY, skipped: 0, duplicates: 0 } });
    const [rows] = await sql`select count(*)::int as n, count(distinct prospect_id)::int as people from workbook_rows where workbook_id = ${wb}`;
    expect(rows).toEqual({ n: MANY, people: MANY });
  }, 180_000);

  it("adds people chosen from search, checking a smart list choice against its filters", async () => {
    const wb = await workbook();
    const search = await call("POST", `/${wb}/prospect-imports`, { source: { type: "search" }, selection: { prospectIds: [id(7), id(MANY), "no-such-person"] } });
    expect(search.statusCode, search.body).toBe(200);
    expect(search.json().data.counts).toMatchObject({ imported: 2, skipped: 1 });
    const smart = await call("POST", `/${wb}/prospect-imports`, { source: { type: "smart_list", smartListId: await smartList({ companyDomain: domain }) }, selection: { prospectIds: [id(8), id(MANY)] } });
    expect(smart.json().data.counts).toMatchObject({ imported: 1, skipped: 1 });
    const rows = await db.select().from(schema.workbookRows).where(eq(schema.workbookRows.workbookId, wb)).orderBy(asc(schema.workbookRows.position));
    expect(rows.map((r) => r.prospectId)).toEqual([id(7), id(MANY), id(8)]);
    const cells = await db.select().from(schema.workbookCells).where(eq(schema.workbookCells.workbookId, wb));
    expect(cells.map((c) => c.value)).toContain("Indexed Person 7");
    expect(JSON.stringify(cells)).not.toContain("unverified");
  });

  it("reports an unreachable search server as unavailable, not as no matches", async () => {
    const wb = await workbook();
    const down = await buildApp({ ...config, OPENSEARCH_URL: "http://127.0.0.1:1" });
    const list = await smartList({ companyDomain: domain });
    const res = await down.inject({ method: "GET", url: `/api/v1/workbooks-v2/${wb}/sources/smart-lists/${list}/prospects`, headers: { "x-stub-user-email": email } });
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json().code).toBe("SEARCH_UNAVAILABLE");
    expect(res.body).not.toContain("127.0.0.1");
    await down.close();
  }, 60_000);
});
