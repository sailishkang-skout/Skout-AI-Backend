import { type Sql, cellSizes, mb, saveResult } from "./db.js";
import { type IndexSetKey, type Variant, dropSecondaryIndexesDdl, indexSetDdl, tables } from "./variants.js";

export interface IndexBuild {
  statement: string;
  createMs: number;
  sizeMB: number;
}

/** Replace the secondary indexes with one set, timing each build and measuring what it adds. */
export async function applyIndexSet(sql: Sql, v: Variant, set: IndexSetKey) {
  for (const stmt of dropSecondaryIndexesDdl(v)) await sql.unsafe(stmt);
  const builds: IndexBuild[] = [];
  let before = (await cellSizes(sql, v)).indexBytes;
  for (const stmt of indexSetDdl(v, set)) {
    const t0 = performance.now();
    await sql.unsafe(stmt);
    const createMs = performance.now() - t0;
    const after = (await cellSizes(sql, v)).indexBytes;
    builds.push({ statement: stmt.replace(/\s+/g, " ").trim(), createMs: Math.round(createMs), sizeMB: mb(after - before) });
    before = after;
  }
  const t0 = performance.now();
  await sql.unsafe(`VACUUM (ANALYZE) ${tables(v).cells}`);
  const vacuumMs = Math.round(performance.now() - t0);
  const sizes = await cellSizes(sql, v);
  const result = { variant: v.key, set, builds, vacuumAnalyzeMs: vacuumMs, heapMB: mb(sizes.heapBytes), indexTotalMB: mb(sizes.indexBytes), totalMB: mb(sizes.totalBytes) };
  saveResult(`indexes.${v.key}.${set}`, result);
  return result;
}
