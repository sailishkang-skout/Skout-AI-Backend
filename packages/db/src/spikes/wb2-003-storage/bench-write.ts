/**
 * Concurrent cell updates, as enrichment runs would issue them.
 *
 * Several "runs" (one per column) each walk the workbook in chunks of 100 rows. A chunk is two committed
 * statements, as a real runner would do around a provider call: claim (compare-and-set into 'running'),
 * then write the results. Grid readers, a user editing input cells and (separately) hot-row contention
 * and same-cell races run alongside. Integrity is checked against values every writer can recompute.
 */
import { type Sql, appliedIndexes, cellSizes, columnIdOf, mb, saveResult, workbookIdOf } from "./db.js";
import { claimSql, chunkRowIdsSql, completeSql, editCellSql, windowSql, WINDOW_SIZE } from "./queries.js";
import { rng, summarize, type Summary, round } from "./stats.js";
import { type Variant, tables } from "./variants.js";

/** Enrichment and AI columns, one per concurrent run (PRD RUN-5: several columns run at once). */
export const WORKER_COLUMNS = [7, 8, 9, 10, 11, 12, 13, 14, 17, 18] as const;
const CHUNK = 100;
const EDIT_COLUMN = 0;

export interface WriteOptions {
  workers: number;
  /** Rows (from position 0) each run processes. */
  rowsPerRun: number;
  readers: number;
}

/** What a run writes for (column, position): deterministic, so correctness can be re-derived in SQL. */
export const expectedFound = (position: number) => position % 10 < 7;
export const expectedValue = (column: number, position: number) => `run-${column}-${position}`;

interface PgStats {
  upd: number;
  hot: number;
  dead: number;
  deadlocks: number;
  walBytes: number;
}

async function pgStats(sql: Sql, v: Variant): Promise<PgStats> {
  await new Promise((r) => setTimeout(r, 1500)); // let the cumulative statistics flush
  const s = tables(v).schema;
  const [t] = await sql.unsafe<{ upd: string; hot: string; dead: string }[]>(
    `SELECT coalesce(sum(n_tup_upd),0)::text AS upd, coalesce(sum(n_tup_hot_upd),0)::text AS hot, coalesce(sum(n_dead_tup),0)::text AS dead
     FROM pg_stat_user_tables WHERE schemaname = '${s}' AND relname LIKE 'workbook_cells%'`
  );
  const [d] = await sql<{ deadlocks: string; lsn: string }[]>`SELECT (SELECT deadlocks FROM pg_stat_database WHERE datname = current_database())::text AS deadlocks, pg_current_wal_lsn()::text AS lsn`;
  const [w] = await sql<{ b: string }[]>`SELECT (pg_wal_lsn_diff(${d!.lsn}::pg_lsn, '0/0'::pg_lsn))::text AS b`;
  return { upd: Number(t!.upd), hot: Number(t!.hot), dead: Number(t!.dead), deadlocks: Number(d!.deadlocks), walBytes: Number(w!.b) };
}


/** Order-independent checksum of a set of cells. */
async function checksum(sql: Sql, v: Variant, where: string): Promise<{ n: number; sum: string }> {
  const t = tables(v);
  const [r] = await sql.unsafe<{ n: string; s: string }[]>(
    `SELECT count(*)::text AS n, coalesce(sum(hashtextextended(c.row_id::text || '|' || c.column_id::text || '|' || coalesce(c.value::text, '~') || '|' || c.state || '|' || coalesce(c.found_via, '') || '|' || c.updated_at::text, 0)::numeric), 0)::text AS s
     FROM ${t.cells} c JOIN ${t.rows} r ON r.id = c.row_id WHERE r.workbook_id = '${workbookIdOf("main")}' AND ${where}`
  );
  return { n: Number(r!.n), sum: r!.s };
}

interface ChunkTimes {
  claim: number[];
  complete: number[];
  chunk: number[];
}

async function runOne(sql: Sql, v: Variant, column: number, fromPos: number, toPos: number, times: ChunkTimes, mistakes: { claimShort: number; completeShort: number }) {
  const wb = workbookIdOf("main");
  const colId = columnIdOf("main", column);
  for (let pos = fromPos; pos < toPos; pos += CHUNK) {
    const n = Math.min(CHUNK, toPos - pos);
    const ids = await sql.unsafe<{ id: string | number; position: number }[]>(chunkRowIdsSql(v), [wb, pos, n]);
    const t0 = performance.now();
    const claimed = await sql.unsafe(claimSql(v), [wb, colId, ids.map((r) => r.id)] as never[]);
    const t1 = performance.now();
    if (claimed.length !== ids.length) mistakes.claimShort++;
    const payload = ids.map((r) => {
      const found = expectedFound(r.position);
      return {
        row_id: r.id,
        value: found ? expectedValue(column, r.position) : null,
        state: found ? "found" : "not_found",
        confidence: found ? 0.9 : null,
        credits_charged: found ? 1 : 0,
        found_via: found ? "skout" : null,
        internal_provenance: found ? { provider: "managed_provider_1", retrieved_at: "2026-11-25" } : null,
        error_code: null,
      };
    });
    const t2 = performance.now();
    const done = await sql.unsafe(completeSql(v), [wb, colId, sql.json(payload as never)] as never[]);
    const t3 = performance.now();
    void done;
    times.claim.push(t1 - t0);
    times.complete.push(t3 - t2);
    times.chunk.push(t3 - t0);
  }
}

export interface WriteResult {
  variant: string;
  label: string;
  indexes: string[];
  /** Quiet-down time and the CPU calibration probe measured just before this run (null = not measured). */
  environment: { settleMs: number; calibrationMs: number; calibrationAfterMs?: number } | null;
  options: WriteOptions;
  elapsedSec: number;
  cellsUpdated: number;
  cellsPerSecond: number;
  perChunk: { claimMs: Summary; completeMs: Summary; totalMs: Summary };
  /** DB time per row, p95 (chunk p95 / 100). PRD: Skout's own processing under 50 ms per row. */
  dbMsPerRowP95: number;
  readersDuringWrites: Summary;
  userEditsDuringWrites: Summary;
  hotUpdateRatio: number;
  walMB: number;
  sizeGrowth: { heapMB: number; indexMB: number };
  deadTuplesAfter: number;
  deadlocks: number;
  integrity: Record<string, unknown>;
  contention?: Record<string, unknown>;
  casRace?: Record<string, unknown>;
}

export async function runWriteBench(sql: Sql, v: Variant, rows: number, opts: WriteOptions, label: string, extras = true, environment: { settleMs: number; calibrationMs: number; calibrationAfterMs?: number } | null = null, calibrateAfter?: () => Promise<number>): Promise<WriteResult> {
  const t = tables(v);
  const wb = workbookIdOf("main");
  const cols = WORKER_COLUMNS.slice(0, opts.workers);
  const R = Math.min(opts.rowsPerRun, rows);
  const targetIds = cols.map((c) => `'${columnIdOf("main", c)}'`).join(",");
  const rand = rng(4242);

  const before = {
    untouched: await checksum(sql, v, `c.column_id NOT IN (${targetIds}, '${columnIdOf("main", EDIT_COLUMN)}')`),
    beyond: await checksum(sql, v, `c.column_id IN (${targetIds}) AND r.position >= ${R}`),
    total: Number((await sql.unsafe<{ n: string }[]>(`SELECT count(*)::text AS n FROM ${t.cells}`))[0]!.n),
  };
  const sizeBefore = await cellSizes(sql, v);
  const statsBefore = await pgStats(sql, v);

  const times: ChunkTimes = { claim: [], complete: [], chunk: [] };
  const mistakes = { claimShort: 0, completeShort: 0 };
  const readerLat: number[] = [];
  const editLat: number[] = [];
  const edits = new Map<string, string>();
  let running = true;

  const readerLoop = async () => {
    const r = rng(777 + Math.floor(Math.random() * 1000));
    while (running) {
      const t0 = performance.now();
      await sql.unsafe(windowSql(v), [wb, Math.floor(r() * (rows - WINDOW_SIZE))]);
      readerLat.push(performance.now() - t0);
    }
  };
  const editLoop = async () => {
    let i = 0;
    while (running) {
      const pos = Math.floor(rand() * rows);
      const [row] = await sql.unsafe<{ id: string | number }[]>(`SELECT id FROM ${t.rows} WHERE workbook_id = $1 AND position = $2`, [wb, pos]);
      const val = `edited-${i++}`;
      const t0 = performance.now();
      await sql.unsafe(editCellSql(v), [wb, row!.id, columnIdOf("main", EDIT_COLUMN), sql.json(val)] as never[]);
      editLat.push(performance.now() - t0);
      edits.set(String(row!.id), val);
      await new Promise((res) => setTimeout(res, 20));
    }
  };

  const started = performance.now();
  const readers = Array.from({ length: opts.readers }, readerLoop);
  const editor = editLoop();
  try {
    await Promise.all(cols.map((c) => runOne(sql, v, c, 0, R, times, mistakes)));
  } finally {
    running = false; // stop readers and the editor even if a run failed, so the real error is not masked
  }
  const elapsedSec = (performance.now() - started) / 1000;
  await Promise.all([...readers, editor]);

  const statsAfter = await pgStats(sql, v);
  const sizeAfter = await cellSizes(sql, v);

  // --- integrity ---------------------------------------------------------------------------------------------
  const mismatchByColumn: Record<number, number> = {};
  for (const c of cols) {
    const [m] = await sql.unsafe<{ n: string }[]>(
      `SELECT count(*)::text AS n FROM ${t.cells} c JOIN ${t.rows} r ON r.id = c.row_id
       WHERE c.column_id = '${columnIdOf("main", c)}' AND r.workbook_id = '${wb}' AND r.position < ${R} AND NOT (
         (r.position % 10 < 7 AND c.state = 'found' AND c.value = to_jsonb('run-${c}-' || r.position::text) AND c.found_via = 'skout' AND c.internal_provenance IS NOT NULL)
         OR (r.position % 10 >= 7 AND c.state = 'not_found' AND c.value IS NULL AND c.found_via IS NULL))`
    );
    mismatchByColumn[c] = Number(m!.n);
  }
  const after = {
    untouched: await checksum(sql, v, `c.column_id NOT IN (${targetIds}, '${columnIdOf("main", EDIT_COLUMN)}')`),
    beyond: await checksum(sql, v, `c.column_id IN (${targetIds}) AND r.position >= ${R}`),
    total: Number((await sql.unsafe<{ n: string }[]>(`SELECT count(*)::text AS n FROM ${t.cells}`))[0]!.n),
  };
  const [stuck] = await sql.unsafe<{ n: string }[]>(
    `SELECT count(*)::text AS n FROM ${t.cells} c JOIN ${t.rows} r ON r.id = c.row_id WHERE c.column_id IN (${targetIds}) AND r.workbook_id = '${wb}' AND r.position < ${R} AND c.state = 'running'`
  );
  const [dupes] = await sql.unsafe<{ n: string }[]>(`SELECT count(*)::text AS n FROM (SELECT 1 FROM ${t.cells} GROUP BY row_id, column_id HAVING count(*) > 1) d`);
  let editsOk = 0;
  for (const [rowId, val] of edits) {
    const [c] = await sql.unsafe<{ value: string }[]>(`SELECT value #>> '{}' AS value FROM ${t.cells} WHERE row_id = $1 AND column_id = $2`, [rowId, columnIdOf("main", EDIT_COLUMN)] as never[]);
    if (c?.value === val) editsOk++;
  }
  const mismatches = Object.values(mismatchByColumn).reduce((a, b) => a + b, 0);
  const integrity = {
    targetCellMismatches: mismatches,
    mismatchByColumn,
    stuckInRunning: Number(stuck!.n),
    duplicatePrimaryKeys: Number(dupes!.n),
    totalCellsBefore: before.total,
    totalCellsAfter: after.total,
    untouchedCellsUnchanged: before.untouched.n === after.untouched.n && before.untouched.sum === after.untouched.sum,
    untouchedCellsChecked: after.untouched.n,
    targetCellsBeyondRangeUnchanged: before.beyond.n === after.beyond.n && before.beyond.sum === after.beyond.sum,
    userEditsApplied: `${editsOk}/${edits.size}`,
    claimShortfalls: mistakes.claimShort,
  };

  const upd = statsAfter.upd - statsBefore.upd;
  const hot = statsAfter.hot - statsBefore.hot;
  const cellsUpdated = cols.length * R;
  const total = summarize(times.chunk);
  const result: WriteResult = {
    variant: v.key,
    label,
    indexes: await appliedIndexes(sql, v),
    environment,
    options: opts,
    elapsedSec: round(elapsedSec, 2),
    cellsUpdated,
    cellsPerSecond: Math.round(cellsUpdated / elapsedSec),
    perChunk: { claimMs: summarize(times.claim), completeMs: summarize(times.complete), totalMs: total },
    dbMsPerRowP95: round(total.p95 / CHUNK, 3),
    readersDuringWrites: summarize(readerLat),
    userEditsDuringWrites: summarize(editLat),
    hotUpdateRatio: upd > 0 ? round(hot / upd, 3) : 0,
    walMB: mb(statsAfter.walBytes - statsBefore.walBytes),
    sizeGrowth: { heapMB: mb(sizeAfter.heapBytes - sizeBefore.heapBytes), indexMB: mb(sizeAfter.indexBytes - sizeBefore.indexBytes) },
    deadTuplesAfter: statsAfter.dead,
    deadlocks: statsAfter.deadlocks - statsBefore.deadlocks,
    integrity,
  };

  // Probe the host again straight after the run: a slowdown that started mid-run shows up here.
  if (environment && calibrateAfter) result.environment = { ...environment, calibrationAfterMs: await calibrateAfter() };
  if (extras) {
    result.contention = await hotRowContention(sql, v, cols, Math.min(1000, rows));
    result.casRace = await casRace(sql, v, rows);
  }
  saveResult(`write.${v.key}.${label}`, result);
  return result;
}

/** All runs hammer the same 1,000 rows at once (worst case for row-level lock conflicts between columns). */
async function hotRowContention(sql: Sql, v: Variant, cols: readonly number[], hotRows: number) {
  const times: ChunkTimes = { claim: [], complete: [], chunk: [] };
  const mistakes = { claimShort: 0, completeShort: 0 };
  let lockWaitSamples = 0;
  let sampling = true;
  const before = await sql<{ d: string }[]>`SELECT deadlocks::text AS d FROM pg_stat_database WHERE datname = current_database()`;
  const sampler = (async () => {
    while (sampling) {
      const [w] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`;
      lockWaitSamples += w!.n;
      await new Promise((r) => setTimeout(r, 25));
    }
  })();
  const t0 = performance.now();
  for (let pass = 0; pass < 5; pass++) await Promise.all(cols.map((c) => runOne(sql, v, c, 0, hotRows, times, mistakes)));
  const elapsed = (performance.now() - t0) / 1000;
  sampling = false;
  await sampler;
  await new Promise((r) => setTimeout(r, 1500));
  const after = await sql<{ d: string }[]>`SELECT deadlocks::text AS d FROM pg_stat_database WHERE datname = current_database()`;
  return {
    description: `${cols.length} runs x ${hotRows.toLocaleString()} shared rows x 5 passes, different columns`,
    totalMs: summarize(times.chunk),
    elapsedSec: round(elapsed, 2),
    lockWaitSamples,
    deadlocks: Number(after[0]!.d) - Number(before[0]!.d),
    claimShortfalls: mistakes.claimShort,
  };
}

/** Two runs try to claim the same cell at the same moment: exactly one must win. */
async function casRace(sql: Sql, v: Variant, rows: number) {
  const t = tables(v);
  const wb = workbookIdOf("main");
  const col = columnIdOf("main", WORKER_COLUMNS[0]);
  const trials = 300;
  let exactlyOne = 0;
  let both = 0;
  let neither = 0;
  const rand = rng(31337);
  for (let i = 0; i < trials; i++) {
    const [row] = await sql.unsafe<{ id: string | number }[]>(`SELECT id FROM ${t.rows} WHERE workbook_id = $1 AND position = $2`, [wb, Math.floor(rand() * rows)]);
    await sql.unsafe(`UPDATE ${t.cells} SET state = 'queued' WHERE row_id = $1 AND column_id = $2`, [row!.id, col] as never[]);
    const [a, b] = await Promise.all([sql.unsafe(claimSql(v), [wb, col, [row!.id]] as never[]), sql.unsafe(claimSql(v), [wb, col, [row!.id]] as never[])]);
    const winners = a.length + b.length;
    if (winners === 1) exactlyOne++;
    else if (winners === 2) both++;
    else neither++;
  }
  return { trials, exactlyOneWinner: exactlyOne, bothClaimed: both, neitherClaimed: neither };
}
