import { type Sql, type Tenants, cellSizes, columnIdOf, ensureTenants, mb, saveResult, vacuumAnalyze, workbookIdOf } from "./db.js";
import { COLUMN_COUNT, dictionaryRows, insertCellsSql, insertRowsSql, insertWorkbookAndColumnsSql, setupGeneratorDdl, type WorkbookSeed } from "./dataset.js";
import { type Variant, VARIANTS, createDdl, createWorkbookPartitionDdl, schemaOf, tables } from "./variants.js";

export const MAIN_ROWS = 100_000;
export const ISOLATION_ROWS = 2_000;

export async function setupGenerator(sql: Sql): Promise<void> {
  for (const stmt of setupGeneratorDdl()) await sql.unsafe(stmt);
  const rows = dictionaryRows();
  await sql`INSERT INTO wbs_gen.dict ${sql(rows, "kind", "idx", "val")}`;
}

export function mainSeed(t: Tenants, rows: number): WorkbookSeed {
  return { tag: "main", workbookId: workbookIdOf("main"), workspaceId: t.workspaceA, userId: t.userA, name: "WB2-003 100k x 20", rows, salt: 0, idBase: 0 };
}

export function isolationSeed(t: Tenants, rows: number): WorkbookSeed {
  return { tag: "iso", workbookId: workbookIdOf("iso"), workspaceId: t.workspaceB, userId: t.userA, name: "WB2-003 other workspace", rows, salt: 7, idBase: 10_000_000 };
}

/** Remove every variant schema except `keep`, so leftovers of earlier runs cannot be vacuumed during a measurement. */
export async function dropOtherVariants(sql: Sql, keep: Variant): Promise<void> {
  for (const other of VARIANTS) if (other.key !== keep.key) await dropVariant(sql, other);
}

export async function dropVariant(sql: Sql, v: Variant): Promise<void> {
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${schemaOf(v)} CASCADE`);
}

export interface LoadTimings {
  rowsMs: number;
  cellsMs: number;
  vacuumAnalyzeMs: number;
}

/** Insert one workbook (workbook row, 20 columns, rows, cells). Returns how long rows and cells took. */
export async function insertWorkbook(sql: Sql, v: Variant, seed: WorkbookSeed): Promise<{ rowsMs: number; cellsMs: number }> {
  for (const stmt of insertWorkbookAndColumnsSql(v, seed)) await sql.unsafe(stmt);
  for (const stmt of createWorkbookPartitionDdl(v, seed.workbookId)) await sql.unsafe(stmt);
  let t0 = performance.now();
  await sql.unsafe(insertRowsSql(v, seed));
  const rowsMs = performance.now() - t0;
  t0 = performance.now();
  await sql.unsafe(insertCellsSql(v, seed));
  const cellsMs = performance.now() - t0;
  if (v.idType === "bigint") {
    await sql.unsafe(`SELECT setval(pg_get_serial_sequence('${tables(v).rows}', 'id'), (SELECT max(id) FROM ${tables(v).rows}))`);
  }
  return { rowsMs, cellsMs };
}

/** Fresh schema, the main 100k x 20 workbook, and a small workbook in a second workspace. */
export async function loadVariant(sql: Sql, v: Variant, rows: number) {
  const tenants = await ensureTenants(sql);
  await dropVariant(sql, v);
  for (const stmt of createDdl(v)) await sql.unsafe(stmt);

  const main = await insertWorkbook(sql, v, mainSeed(tenants, rows));
  const iso = await insertWorkbook(sql, v, isolationSeed(tenants, Math.min(ISOLATION_ROWS, rows)));
  const vacuumAnalyzeMs = await vacuumAnalyze(sql, v);
  const sizes = await cellSizes(sql, v);

  const [c] = await sql.unsafe<{ rows: string; cells: string; cols: string; wbs: string }[]>(`
    SELECT (SELECT count(*) FROM ${tables(v).rows} WHERE workbook_id = '${workbookIdOf("main")}')::text AS rows,
           (SELECT count(*) FROM ${tables(v).cells} WHERE ${v.workbookIdOnCells ? `workbook_id = '${workbookIdOf("main")}'` : `column_id IN (SELECT id FROM ${tables(v).columns} WHERE workbook_id = '${workbookIdOf("main")}')`})::text AS cells,
           (SELECT count(*) FROM ${tables(v).columns} WHERE workbook_id = '${workbookIdOf("main")}')::text AS cols,
           (SELECT count(*) FROM ${tables(v).workbooks})::text AS wbs`);
  const result = {
    variant: v,
    timings: { rowsMs: Math.round(main.rowsMs), cellsMs: Math.round(main.cellsMs), vacuumAnalyzeMs: Math.round(vacuumAnalyzeMs) },
    cellsPerSecond: Math.round(Number(c!.cells) / (main.cellsMs / 1000)),
    counts: { rows: Number(c!.rows), cells: Number(c!.cells), columns: Number(c!.cols), workbooks: Number(c!.wbs) },
    sizes: { heapMB: mb(sizes.heapBytes), indexMB: mb(sizes.indexBytes), totalMB: mb(sizes.totalBytes), partitions: sizes.partitions },
    bytesPerCell: Math.round(sizes.totalBytes / Number(c!.cells)),
    isolationLoadMs: Math.round(iso.cellsMs + iso.rowsMs),
  };
  saveResult(`load.${v.key}`, result);
  return result;
}

export { COLUMN_COUNT, columnIdOf };
