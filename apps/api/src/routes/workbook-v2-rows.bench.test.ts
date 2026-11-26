import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { eq, sql as dsql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { createDb, schema } from "@skout/db";
import { invalidateWorkspaceAccess } from "@skout/auth";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { seedBenchWorkbook } from "../test/workbook-rows-dataset.js";
import { countStatement, pageStatement, type RowQuery } from "../services/workbook-rows.query.js";
import { inputDataType } from "../services/workbook-cell-values.js";

/**
 * WB2-012 performance targets, measured through the HTTP API on a 100,000-row, 20-column workbook (2,000,000 cells)
 * that shares its tables with other workspaces' workbooks.
 *
 * Skipped unless asked for; it takes a few minutes and about 1 GB of database. Use a throwaway database:
 *   ROWS_BENCHMARK=1 DATABASE_URL=postgresql://.../wb_bench npx vitest run src/routes/workbook-v2-rows.bench.test.ts
 * ROWS_BENCHMARK_REPORT=<file> also writes the timings and query plans as JSON.
 */
const base = loadEnv();
const enabled = process.env.ROWS_BENCHMARK === "1" && Boolean(base.DATABASE_URL);

const ROWS = 100_000;
/** Other workbooks in the same tables, so no query can rely on the target being alone. */
const NEIGHBOURS = 5;
const NEIGHBOUR_ROWS = 20_000;
const SAMPLES = Number(process.env.ROWS_BENCHMARK_SAMPLES ?? 100);
const WARMUP = 3;
const WINDOW_TARGET_MS = 300;
const QUERY_TARGET_MS = 1_500;

interface Result {
  scenario: string;
  group: "window" | "query" | "write";
  samples: number;
  p50: number;
  p95: number;
  max: number;
  matched?: number;
  responseKb: number;
}

describe.skipIf(!enabled)("WB2-012 rows benchmark (100,000 rows x 20 columns)", () => {
  const { db, sql } = createDb(base.DATABASE_URL!);
  const suffix = Math.random().toString(36).slice(2, 10);
  const email = `wb2-bench-${suffix}@test.com`;
  const results: Result[] = [];
  const plans: Record<string, unknown> = {};
  const environment: Record<string, unknown> = {};
  const workspaces: string[] = [];
  let app: Awaited<ReturnType<typeof buildApp>>;
  let origin: string;
  let workspaceId: string;
  let workbookId: string;
  let col: Record<string, string>;

  beforeAll(async () => {
    app = await buildApp({ ...base, CLERK_SECRET_KEY: undefined, LOG_LEVEL: "fatal", OPENSEARCH_URL: undefined, EARLY_ACCESS_GATE_ENABLED: "true", RATE_LIMIT_MAX: 1_000_000 });
    origin = await app.listen({ port: 0, host: "127.0.0.1" });

    await app.inject({ method: "GET", url: "/api/v1/me", headers: { "x-stub-user-email": email } });
    const [u] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
    const [m] = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, u!.id));
    workspaceId = m!.workspaceId;
    await db.update(schema.workspaces).set({ accessStatus: "active" }).where(eq(schema.workspaces.id, workspaceId));
    await db.insert(schema.entitlements).values({ workspaceId, key: "feature.workbooks_v2", value: true, source: "test" });
    await db.insert(schema.entitlements).values({ workspaceId, key: "workbooks.row_limit", value: 200_000, source: "test" });
    invalidateWorkspaceAccess(workspaceId);

    for (let i = 0; i < NEIGHBOURS; i++) {
      const [ws] = await sql`insert into workspaces (name, slug) values ('Rows benchmark neighbour', ${`wb2-bench-${suffix}-${i}`}) returning id`;
      workspaces.push(ws!.id as string);
      await seedBenchWorkbook(sql, ws!.id as string, null, NEIGHBOUR_ROWS);
    }
    const seeded = await seedBenchWorkbook(sql, workspaceId, u!.id, ROWS);
    workbookId = seeded.workbookId;
    col = seeded.columns;

    const [settings] = await sql`select version() as version, current_setting('shared_buffers') as shared_buffers, current_setting('work_mem') as work_mem,
      current_setting('max_parallel_workers_per_gather') as parallel_workers`;
    const [counts] = await sql`select (select count(*)::int from workbook_cells) as cells_in_table,
      (select count(*)::int from workbook_cells where workbook_id = ${workbookId}) as cells,
      (select count(*)::int from workbook_rows where workbook_id = ${workbookId}) as rows`;
    Object.assign(environment, settings, counts, { node: process.version, samplesPerScenario: SAMPLES, warmupRequests: WARMUP });
    expect(counts).toMatchObject({ rows: ROWS, cells: ROWS * 20 });
  }, 600_000);

  afterAll(async () => {
    const table = results.map((r) => `${r.group.padEnd(6)} ${r.scenario.padEnd(44)} p50 ${r.p50.toFixed(0).padStart(5)}  p95 ${r.p95.toFixed(0).padStart(5)}  max ${r.max.toFixed(0).padStart(5)} ms  ${String(r.matched ?? "").padStart(7)}  ${r.responseKb.toFixed(0).padStart(5)} KB`);
    process.stdout.write(`\n${JSON.stringify(environment)}\n${table.join("\n")}\n`);
    if (process.env.ROWS_BENCHMARK_REPORT) writeFileSync(process.env.ROWS_BENCHMARK_REPORT, JSON.stringify({ environment, results, plans }, null, 2));
    // The bench workbooks go; the cells follow through the foreign keys.
    await sql`delete from workbooks where id = ${workbookId}`;
    for (const id of workspaces) await sql`delete from workbooks where workspace_id = ${id}`;
    await app.close();
    await sql.end();
  }, 600_000);

  async function request(method: string, path: string, body?: unknown) {
    const started = performance.now();
    const res = await fetch(`${origin}/api/v1/workbooks-v2/${workbookId}${path}`, {
      method,
      headers: { "x-stub-user-email": email, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const ms = performance.now() - started; // includes sending the whole response over the socket
    if (!res.ok) throw new Error(`${method} ${path} ${res.status} ${text.slice(0, 300)}`);
    return { ms, kb: text.length / 1024, json: JSON.parse(text) };
  }

  const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;

  function record(scenario: string, group: Result["group"], times: number[], responseKb: number, matched?: number) {
    const sorted = [...times].sort((a, z) => a - z);
    const result = { scenario, group, samples: times.length, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), max: sorted.at(-1)!, matched, responseKb };
    results.push(result);
    return result;
  }

  async function measure(scenario: string, group: Result["group"], run: (i: number) => ReturnType<typeof request>, samples = SAMPLES) {
    for (let i = 0; i < WARMUP; i++) await run(i);
    const times: number[] = [];
    let last!: Awaited<ReturnType<typeof request>>;
    for (let i = 0; i < samples; i++) {
      last = await run(i);
      times.push(last.ms);
    }
    return { ...record(scenario, group, times, last.kb, last.json.window?.matched), last };
  }

  /** A repeatable spread of offsets over the whole workbook. */
  const offsetAt = (i: number) => (i * 7_919 * 13) % (ROWS - 200);

  // ── Windows ─────────────────────────────────────────────────────────────────

  const windows: Array<[string, (i: number) => string]> = [
    ["first 200 rows, 20 columns", () => "/rows?limit=200"],
    ["200 rows at spread offsets, 20 columns", (i) => `/rows?limit=200&offset=${offsetAt(i)}`],
    ["last 200 rows (offset 99,800), 20 columns", () => `/rows?limit=200&offset=${ROWS - 200}`],
    ["200 rows at spread offsets, 8 columns", (i) => `/rows?limit=200&offset=${offsetAt(i)}&columnIds=${Object.values(col).slice(0, 8).join(",")}`],
  ];

  it.each(windows)(
    `window: %s is under ${WINDOW_TARGET_MS} ms p95`,
    async (name, path) => {
      const r = await measure(name, "window", (i) => request("GET", path(i)));
      expect(r.last.json.data).toHaveLength(200);
      expect(r.p95).toBeLessThan(WINDOW_TARGET_MS);
    },
    600_000
  );

  it(`window: 5 requests at a time at spread offsets stay under ${WINDOW_TARGET_MS} ms p95`, async () => {
    const times: number[] = [];
    let kb = 0;
    for (let batch = 0; batch < Math.ceil(SAMPLES / 5); batch++) {
      const done = await Promise.all(Array.from({ length: 5 }, (_, j) => request("GET", `/rows?limit=200&offset=${offsetAt(batch * 5 + j)}`)));
      times.push(...done.map((d) => d.ms));
      kb = done[0]!.kb;
    }
    expect(record("200 rows, 5 concurrent requests", "window", times, kb).p95).toBeLessThan(WINDOW_TARGET_MS);
  }, 600_000);

  // ── Sort, filter, search ────────────────────────────────────────────────────

  const value = (key: string, op: string, v?: unknown) => ({ type: "value", columnId: col[key], op, ...(v === undefined ? {} : { value: v }) });
  const by = (key: string, direction: "asc" | "desc" = "asc") => ({ columnId: col[key], direction });

  const queries: Array<[string, () => Record<string, unknown>]> = [
    ["sort by text column", () => ({ sort: [by("company")] })],
    ["sort by text column, deep offset 90,000", () => ({ sort: [by("company")], offset: 90_000 })],
    ["sort by long unique text", () => ({ sort: [by("linkedin", "desc")] })],
    ["sort by number column", () => ({ sort: [by("employees", "desc")] })],
    ["sort by sparse enrichment column", () => ({ sort: [by("phone")] })],
    ["sort by 3 columns", () => ({ sort: [by("country"), by("industry"), by("score", "desc")] })],
    ["sort by 3 columns, last page", () => ({ sort: [by("country"), by("industry"), by("score", "desc")], offset: ROWS - 200 })],
    ["sort by row source", () => ({ sort: [{ field: "source" }] })],
    ["filter contains", () => ({ filters: [value("domain", "contains", ".io")] })],
    ["filter number greater than", () => ({ filters: [value("score", "gt", 80)] })],
    ["filter is empty", () => ({ filters: [value("phone", "is_empty")] })],
    ["filter has value", () => ({ filters: [value("phone", "has_value")] })],
    ["filter does not contain", () => ({ filters: [value("domain", "not_contains", "acme")] })],
    ["filter state, one column", () => ({ filters: [{ type: "state", columnId: col.workEmail, states: ["error"] }] })],
    ["filter state, any column", () => ({ filters: [{ type: "state", states: ["error"] }] })],
    ["filter row source", () => ({ filters: [{ type: "source", sources: ["hubspot"] }] })],
    ["filter matching nothing", () => ({ filters: [value("company", "equals", "no such company")] })],
    ["filter + sort", () => ({ filters: [value("score", "gt", 20)], sort: [by("company")] })],
    [
      "5 filters + 3 sorts",
      () => ({
        filters: [value("domain", "contains", "a"), value("score", "gt", 10), value("phone", "has_value"), { type: "state", columnId: col.workEmail, states: ["found", "error"] }, { type: "source", sources: ["csv", "list"] }],
        sort: [by("company"), by("industry", "desc"), by("score", "desc")],
      }),
    ],
    [
      "10 filters + 3 sorts (request maximum)",
      () => ({
        filters: ["firstName", "lastName", "company", "domain", "employees", "linkedin", "location", "score", "fullName", "emailStatus"].map((key) => value(key, "has_value")),
        sort: [by("company"), by("industry", "desc"), by("score", "desc")],
      }),
    ],
    ["search, common word", () => ({ search: "software" })],
    ["search, rare value", () => ({ search: "hannah.tanaka@" })],
    ["search, no match", () => ({ search: "zzzzqqqq" })],
    ["search, one character (matches most rows)", () => ({ search: "e" })],
    ["search + filter + sort", () => ({ search: "systems", filters: [value("score", "gt", 50)], sort: [by("company")] })],
  ];

  it.each(queries)(
    `query: %s is under ${QUERY_TARGET_MS} ms p95`,
    async (name, body) => {
      const r = await measure(name, "query", () => request("POST", "/rows/query", { limit: 200, ...body() }), Math.max(20, Math.round(SAMPLES / 2)));
      const { window } = r.last.json;
      expect(window.total).toBe(ROWS);
      if (name.includes("nothing") || name.includes("no match")) expect(window.matched).toBe(0);
      else expect(window.returned).toBeGreaterThan(0);
      expect(r.p95).toBeLessThan(QUERY_TARGET_MS);
    },
    600_000
  );

  it("answers a sort over all rows correctly at this size", async () => {
    const top = (await request("POST", "/rows/query", { limit: 5, sort: [by("employees", "desc")] })).json;
    const [expected] = await sql`select max((value #>> '{}')::int) as n from workbook_cells where workbook_id = ${workbookId} and column_id = ${col.employees!}`;
    expect(top.data[0].cells[col.employees!].value).toBe(expected!.n);
    const matched = (await request("POST", "/rows/query", { limit: 1, filters: [value("score", "gt", 80)] })).json.window.matched;
    const [count] = await sql`select count(*)::int as n from workbook_cells where workbook_id = ${workbookId} and column_id = ${col.score!} and (value #>> '{}')::int > 80`;
    expect(matched).toBe(count!.n);
  });

  it("records the query plans", async () => {
    const types = new Map(Object.values(col).map((id) => [id, inputDataType({})]));
    types.set(col.employees!, "number");
    const dialect = new PgDialect();
    const asQuery = (body: Record<string, unknown>): RowQuery => ({ offset: 0, limit: 200, sort: [], filters: [], ...(body as Partial<RowQuery>) });
    const chosen = ["sort by text column", "sort by 3 columns", "filter number greater than", "filter state, any column", "5 filters + 3 sorts", "search, common word"];
    const statements = [
      ["window at offset 99,800", pageStatement(workbookId, asQuery({ offset: ROWS - 200 }), types)] as const,
      ...queries.filter(([name]) => chosen.includes(name)).map(([name, body]) => [name, pageStatement(workbookId, asQuery(body()), types)] as const),
      ["count only (page past the last match)", countStatement(workbookId, asQuery({ search: "software" }))] as const,
    ];
    for (const [name, statement] of statements) {
      plans[name] = await db.transaction(async (tx) => {
        await tx.execute(dsql`SET LOCAL work_mem = '32MB'`);
        const explained = (await tx.execute(dsql`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) ${statement}`)) as unknown as Array<Record<string, string>>;
        return { sql: dialect.sqlToQuery(statement).sql.replace(/\s+/g, " "), plan: explained.map((r) => r["QUERY PLAN"]) };
      });
    }
    // The cells of a window are read through the primary key, never by scanning the table.
    const ids = (await sql`select id from workbook_rows where workbook_id = ${workbookId} order by position limit 200 offset 50000`).map((r) => Number(r.id));
    const cellPlan = (await db.execute(dsql`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT * FROM workbook_cells WHERE workbook_id = ${workbookId}::uuid AND row_id IN (${dsql.join(ids.map((id) => dsql`${id}`), dsql`, `)})`)) as unknown as Array<Record<string, string>>;
    plans["cells of one window"] = { plan: cellPlan.map((r) => r["QUERY PLAN"]!.replace(/ANY \('\{.*?\}'::bigint\[\]\)/, "ANY (<200 row ids>)")) };
    expect(JSON.stringify(plans["cells of one window"])).not.toContain("Seq Scan");
  }, 600_000);

  // ── Writes, for the record (no target in WB2-012) ───────────────────────────

  it("adds, edits and deletes rows in the 100,000-row workbook", async () => {
    const added: number[] = [];
    await measure("bulk add 1,000 rows x 7 input cells", "write", async (i) => {
      const rows = Array.from({ length: 1_000 }, (_, j) => ({ cells: Object.fromEntries(["firstName", "lastName", "company", "domain", "employees", "linkedin", "location"].map((key) => [col[key], key === "employees" ? j : `bench ${i} ${j}`])) }));
      const res = await request("POST", "/rows/bulk", { rows });
      added.push(...res.json.data.rows.map((r: { id: number }) => r.id));
      return res;
    }, 20);
    await measure("add one row", "write", async () => {
      const res = await request("POST", "/rows", {});
      added.push(res.json.data.id);
      return res;
    }, 30);
    await measure("edit one cell", "write", (i) => request("PATCH", `/rows/${added[i]}`, { cells: { [col.company!]: `Edited ${i}` } }), 30);
    await measure("delete one row", "write", () => request("DELETE", `/rows/${added.pop()}`), 30);
    await measure("delete 1,000 rows", "write", () => request("POST", "/rows/delete", { rowIds: added.splice(0, 1_000) }), 15);
    const [state] = await sql`select w.row_count, (select count(*)::int from workbook_rows r where r.workbook_id = w.id) as rows from workbooks w where w.id = ${workbookId}`;
    expect(state!.row_count).toBe(state!.rows);
  }, 600_000);
});
