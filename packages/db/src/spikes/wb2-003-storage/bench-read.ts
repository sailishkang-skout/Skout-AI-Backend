/** Read benchmarks: 200-row windows, sorting and filtering on a cell column, across 100k rows. */
import { type Sql, appliedIndexes, columnIdOf, workbookIdOf } from "./db.js";
import { COL } from "./dataset.js";
import {
  FILTERS,
  type FilterKind,
  WINDOW_SIZE,
  filteredCountSql,
  filteredSortedWindowSql,
  filteredWindowSql,
  sortedWindowSql,
  windowSql,
} from "./queries.js";
import { type Summary, rng, summarize, round } from "./stats.js";
import { type Variant } from "./variants.js";

export interface Case {
  name: string;
  /** PRD target in ms for p95, if the case is a target case. */
  targetMs?: number;
  iterations: number;
  concurrency?: number;
  build: (n: number, rand: () => number) => { sql: string; params: unknown[] };
}

export interface CaseResult {
  name: string;
  targetMs: number | null;
  concurrency: number;
  summary: Summary;
  /** Response size of one sample, to show what a window costs to transfer. */
  sampleRows: number;
  sampleBytes: number;
  stoppedEarly: boolean;
}

export function buildCases(v: Variant, rows: number): Case[] {
  const wb = workbookIdOf("main");
  const col = (i: number) => columnIdOf("main", i);
  const maxStart = rows - WINDOW_SIZE;
  const windowAt = (pos: (n: number, r: () => number) => number) => (n: number, r: () => number) => ({ sql: windowSql(v), params: [wb, pos(n, r)] });

  const cases: Case[] = [
    { name: "window_random", targetMs: 300, iterations: 300, build: windowAt((_, r) => Math.floor(r() * maxStart)) },
    { name: "window_first", targetMs: 300, iterations: 60, build: windowAt(() => 0) },
    { name: "window_middle", targetMs: 300, iterations: 60, build: windowAt((_, r) => Math.floor(rows / 2) + Math.floor(r() * 1000)) },
    { name: "window_last", targetMs: 300, iterations: 60, build: windowAt(() => maxStart) },
    { name: "window_8_concurrent_clients", targetMs: 300, iterations: 800, concurrency: 8, build: windowAt((_, r) => Math.floor(r() * maxStart)) },
  ];

  const sorted = (name: string, column: number, dir: "ASC" | "DESC", deep: boolean, key: "value" | "prefix" = "value"): Case => ({
    name,
    targetMs: 1500,
    iterations: 20,
    build: (_, r) => ({ sql: sortedWindowSql(v, dir, key), params: [wb, col(column), deep ? Math.floor(r() * maxStart) : 0] }),
  });
  cases.push(
    sorted("sort_company_asc_top", COL.company, "ASC", false),
    sorted("sort_company_asc_deep_offset", COL.company, "ASC", true),
    sorted("sort_lead_score_desc_top", COL.leadScore, "DESC", false),
    sorted("sort_ai_summary_asc_deep_offset", COL.aiSummary, "ASC", true),
    sorted("sort_company_prefix_key_top", COL.company, "ASC", false, "prefix")
  );

  for (const kind of Object.keys(FILTERS) as FilterKind[]) {
    const f = FILTERS[kind];
    cases.push(
      {
        name: `filter_${kind}_window`,
        targetMs: 1500,
        iterations: 20,
        build: (_, r) => ({ sql: filteredWindowSql(v, f), params: [wb, col(f.column), Math.floor(r() * 2000)] }),
      },
      { name: `filter_${kind}_count`, targetMs: 1500, iterations: 20, build: () => ({ sql: filteredCountSql(v, f), params: [wb, col(f.column)] }) }
    );
  }
  cases.push({
    name: "filter_found_email_sorted_by_company",
    targetMs: 1500,
    iterations: 20,
    build: (_, r) => ({ sql: filteredSortedWindowSql(v), params: [wb, col(COL.workEmail), col(COL.company), Math.floor(r() * 2000)] }),
  });
  return cases;
}

const CASE_BUDGET_MS = 25_000;

export async function runCase(sql: Sql, c: Case, rand: () => number, warmup = true): Promise<CaseResult> {
  const conc = c.concurrency ?? 1;
  // A cold-cache run must keep its first queries: they are the measurement.
  const warm = warmup ? Math.min(5, Math.ceil(c.iterations / 10)) : 0;
  for (let i = 0; i < warm; i++) {
    const q = c.build(i, rand);
    await sql.unsafe(q.sql, q.params as never[]);
  }
  const samples: number[] = [];
  let sampleRows = 0;
  let sampleBytes = 0;
  const started = performance.now();
  let stoppedEarly = false;
  let next = 0;
  const worker = async () => {
    for (;;) {
      const n = next++;
      if (n >= c.iterations) return;
      if (performance.now() - started > CASE_BUDGET_MS && samples.length >= 8) {
        stoppedEarly = true;
        return;
      }
      const q = c.build(n, rand);
      const t0 = performance.now();
      const res = await sql.unsafe(q.sql, q.params as never[]);
      samples.push(performance.now() - t0);
      if (n === 0) {
        sampleRows = res.length;
        sampleBytes = Buffer.byteLength(JSON.stringify(res));
      }
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));
  return { name: c.name, targetMs: c.targetMs ?? null, concurrency: conc, summary: summarize(samples), sampleRows, sampleBytes, stoppedEarly };
}

export interface ReadSuite {
  variant: string;
  label: string;
  indexes: string[];
  rows: number;
  results: CaseResult[];
}

export async function runReadSuite(sql: Sql, v: Variant, rows: number, seed: number, only?: RegExp, warmup = true): Promise<ReadSuite> {
  const rand = rng(seed);
  const results: CaseResult[] = [];
  for (const c of buildCases(v, rows)) {
    if (only && !only.test(c.name)) continue;
    results.push(await runCase(sql, c, rand, warmup));
  }
  return { variant: v.key, label: v.label, indexes: await appliedIndexes(sql, v), rows, results };
}

/** EXPLAIN (ANALYZE, BUFFERS) of one representative request per case. */
export async function explainSuite(sql: Sql, v: Variant, rows: number): Promise<string> {
  const rand = rng(99);
  const out: string[] = [];
  for (const c of buildCases(v, rows)) {
    if (c.name === "window_8_concurrent_clients") continue;
    const q = c.build(1, rand);
    const plan = await sql.unsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN (ANALYZE, BUFFERS, SETTINGS) ${q.sql}`, q.params as never[]);
    out.push(`### ${c.name}\n${plan.map((p) => p["QUERY PLAN"]).join("\n")}\n`);
  }
  return out.join("\n");
}

/** p95 of a case across repeated suites: min/median/max. */
export function p95Across(suites: ReadSuite[], name: string) {
  const v = suites.map((s) => s.results.find((r) => r.name === name)?.summary.p95).filter((x): x is number => typeof x === "number");
  const sorted = [...v].sort((a, b) => a - b);
  return { min: round(sorted[0] ?? NaN), median: round(sorted[Math.floor(sorted.length / 2)] ?? NaN), max: round(sorted[sorted.length - 1] ?? NaN) };
}
