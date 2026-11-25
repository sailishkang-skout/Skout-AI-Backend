/** What happens as more workbooks are created: table growth, purging a workbook, and per-workbook partition DDL. */
import { type Sql, cellSizes, ensureTenants, mb, saveResult, vacuumAnalyze, workbookIdOf } from "./db.js";
import { type WorkbookSeed } from "./dataset.js";
import { insertWorkbook } from "./load.js";
import { windowSql, WINDOW_SIZE } from "./queries.js";
import { rng, round, summarize } from "./stats.js";
import { type Variant, createWorkbookPartitionDdl, tables } from "./variants.js";

export interface GrowthOptions {
  big: number;
  bigRows: number;
  small: number;
  smallRows: number;
}

export function growthSeed(tag: string, n: number, workspaceId: string, userId: string, rows: number): WorkbookSeed {
  return { tag, workbookId: workbookIdOf(tag), workspaceId, userId, name: `growth ${tag}`, rows, salt: 100 + n, idBase: 20_000_000 + n * 200_000 };
}

/** Add `big` workbooks of `bigRows` rows and `small` workbooks of `smallRows` rows (20 columns each). */
export async function addGrowth(sql: Sql, v: Variant, o: GrowthOptions, label: string) {
  const tenants = await ensureTenants(sql);
  const t0 = performance.now();
  const loads: Array<{ tag: string; rows: number; cellsMs: number }> = [];
  let n = 0;
  for (let i = 0; i < o.big; i++, n++) {
    const tag = `big${i}`;
    const r = await insertWorkbook(sql, v, growthSeed(tag, n, i % 2 ? tenants.workspaceB : tenants.workspaceA, tenants.userA, o.bigRows));
    loads.push({ tag, rows: o.bigRows, cellsMs: Math.round(r.cellsMs) });
  }
  const smallStart = performance.now();
  for (let i = 0; i < o.small; i++, n++) {
    const tag = `small${i}`;
    await insertWorkbook(sql, v, growthSeed(tag, n, i % 2 ? tenants.workspaceB : tenants.workspaceA, tenants.userA, o.smallRows));
  }
  const smallMs = performance.now() - smallStart;
  const totalMs = performance.now() - t0;
  const vacuumMs = await vacuumAnalyze(sql, v);
  const sizes = await cellSizes(sql, v);
  const [c] = await sql.unsafe<{ cells: string; wbs: string }[]>(`SELECT (SELECT count(*) FROM ${tables(v).cells})::text AS cells, (SELECT count(*) FROM ${tables(v).workbooks})::text AS wbs`);
  const result = {
    variant: v.key,
    options: o,
    workbooks: Number(c!.wbs),
    totalCells: Number(c!.cells),
    bigLoads: loads,
    smallWorkbooksLoadMsEach: o.small ? Math.round(smallMs / o.small) : null,
    totalLoadSec: round(totalMs / 1000, 1),
    vacuumAnalyzeSec: round(vacuumMs / 1000, 1),
    sizes: { heapMB: mb(sizes.heapBytes), indexMB: mb(sizes.indexBytes), totalMB: mb(sizes.totalBytes), partitions: sizes.partitions },
  };
  saveResult(`growth.${v.key}.${label}`, result);
  return result;
}

/** Remove one workbook completely (what the 30-day soft-delete purge will do). */
export async function purgeWorkbook(sql: Sql, v: Variant, tag: string, label: string) {
  const t = tables(v);
  const id = workbookIdOf(tag);
  const [{ s }] = await sql<{ s: string }[]>`SELECT pg_current_wal_lsn()::text AS s`;
  const [before] = await sql.unsafe<{ n: string }[]>(`SELECT count(*)::text AS n FROM ${t.rows} WHERE workbook_id = '${id}'`);
  const t0 = performance.now();
  let method = "DELETE FROM workbooks (cascade through rows, columns, cells)";
  if (v.partition === "list_workbook") {
    method = "DETACH + DROP the workbook's partition, then DELETE the workbook (rows cascade)";
    const part = `${t.cells}_wb_${id.replace(/-/g, "")}`;
    await sql.unsafe(`ALTER TABLE ${t.cells} DETACH PARTITION ${part}`);
    await sql.unsafe(`DROP TABLE ${part}`);
  }
  await sql.unsafe(`DELETE FROM ${t.workbooks} WHERE id = '${id}'`);
  const purgeMs = performance.now() - t0;
  const [{ e }] = await sql<{ e: string }[]>`SELECT pg_current_wal_lsn()::text AS e`;
  const [{ b }] = await sql<{ b: string }[]>`SELECT pg_wal_lsn_diff(${e}::pg_lsn, ${s}::pg_lsn)::text AS b`;
  await new Promise((r) => setTimeout(r, 1500));
  const [dead] = await sql.unsafe<{ d: string }[]>(
    `SELECT coalesce(sum(n_dead_tup), 0)::text AS d FROM pg_stat_user_tables WHERE schemaname = '${t.schema}' AND relname LIKE 'workbook_%'`
  );
  const result = { variant: v.key, tag, rowsRemoved: Number(before!.n), cellsRemoved: Number(before!.n) * 20, method, purgeMs: Math.round(purgeMs), walMB: mb(Number(b)), deadTuplesAfter: Number(dead!.d) };
  saveResult(`purge.${v.key}.${label}`, result);
  return result;
}

/**
 * Create `count` new per-workbook partitions while a grid reader hammers an existing workbook.
 * Shows whether CREATE TABLE ... PARTITION OF stalls readers (it takes a strong lock on the parent).
 */
export async function ddlLockTest(sql: Sql, v: Variant, rows: number, count: number, label: string) {
  const wb = workbookIdOf("main");
  const t = tables(v);
  const measure = async (ms: number) => {
    const lat: number[] = [];
    const r = rng(11);
    const end = performance.now() + ms;
    while (performance.now() < end) {
      const t0 = performance.now();
      await sql.unsafe(windowSql(v), [wb, Math.floor(r() * (rows - WINDOW_SIZE))]);
      lat.push(performance.now() - t0);
    }
    return lat;
  };
  const baseline = summarize(await measure(3000));
  const during: number[] = [];
  let running = true;
  const reader = (async () => {
    const r = rng(12);
    while (running) {
      const t0 = performance.now();
      await sql.unsafe(windowSql(v), [wb, Math.floor(r() * (rows - WINDOW_SIZE))]);
      during.push(performance.now() - t0);
    }
  })();
  const ddlMs: number[] = [];
  for (let i = 0; i < count; i++) {
    const id = workbookIdOf(`ddl${i}`);
    const [{ ws }] = await sql<{ ws: string }[]>`SELECT id AS ws FROM public.workspaces WHERE slug = 'wb2003-spike-a'`;
    await sql.unsafe(`INSERT INTO ${t.workbooks} (id, workspace_id, name) VALUES ('${id}', '${ws}', 'ddl probe ${i}')`);
    const t0 = performance.now();
    for (const stmt of createWorkbookPartitionDdl(v, id)) await sql.unsafe(stmt);
    ddlMs.push(performance.now() - t0);
    await new Promise((r) => setTimeout(r, 40));
  }
  running = false;
  await reader;
  const result = {
    variant: v.key,
    partitionsCreated: count,
    createPartitionMs: summarize(ddlMs),
    readerBaselineMs: baseline,
    readerDuringDdlMs: summarize(during),
  };
  for (let i = 0; i < count; i++) await sql.unsafe(`DELETE FROM ${t.workbooks} WHERE id = '${workbookIdOf(`ddl${i}`)}'`);
  saveResult(`ddllock.${v.key}.${label}`, result);
  return result;
}

/** Planning time of the window query, which grows with the partition count. */
export async function planningTime(sql: Sql, v: Variant, rows: number, label: string) {
  const wb = workbookIdOf("main");
  const [parts] = await sql.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM pg_partition_tree('${tables(v).cells}'::regclass) WHERE isleaf`).catch(() => [{ n: 1 }]);
  const samples: number[] = [];
  const exec: number[] = [];
  for (let i = 0; i < 40; i++) {
    const plan = await sql.unsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN (ANALYZE) ${windowSql(v)}`, [wb, (i * 997) % (rows - WINDOW_SIZE)] as never[]);
    const text = plan.map((p) => p["QUERY PLAN"]).join("\n");
    samples.push(Number(/Planning Time: ([\d.]+) ms/.exec(text)![1]));
    exec.push(Number(/Execution Time: ([\d.]+) ms/.exec(text)![1]));
  }
  const result = { variant: v.key, partitions: parts?.n ?? 1, planningMs: summarize(samples.slice(5)), executionMs: summarize(exec.slice(5)) };
  saveResult(`planning.${v.key}.${label}`, result);
  return result;
}
