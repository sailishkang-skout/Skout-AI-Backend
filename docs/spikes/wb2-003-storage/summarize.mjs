#!/usr/bin/env node
// Prints the markdown tables used in WB2-003-storage-decision.md straight from results/*.json,
// so no number in the document is typed by hand.   node summarize.mjs [section]
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "results");
const load = (f) => (existsSync(path.join(dir, f)) ? JSON.parse(readFileSync(path.join(dir, f), "utf8")) : null);
const f0 = (n) => (n == null || Number.isNaN(n) ? "-" : Math.round(n).toLocaleString("en-US"));
const f1 = (n) => (n == null || Number.isNaN(n) ? "-" : (Math.round(n * 10) / 10).toLocaleString("en-US"));
const table = (head, rows) => [`| ${head.join(" | ")} |`, `|${head.map((_, i) => (i ? "---:" : "---")).join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
const p95 = (file, name, suite = 0) => {
  const d = load(file);
  if (!d) return null;
  const s = d.suites ? d.suites[suite] : d;
  return s.results.find((r) => r.name === name)?.summary.p95 ?? null;
};
const p95Runs = (file, name) => {
  const d = load(file);
  const v = d?.p95AcrossRuns?.[name];
  return v ? `${f0(v.median)} (${f0(v.min)}–${f0(v.max)})` : null;
};

const READ = ["window_random", "window_first", "window_last", "window_8_concurrent_clients", "sort_company_asc_top", "sort_company_asc_deep_offset", "sort_lead_score_desc_top", "sort_ai_summary_asc_deep_offset", "filter_state_error_window", "filter_value_equals_window", "filter_text_contains_window", "filter_numeric_gt_window", "filter_is_empty_window", "filter_found_email_sorted_by_company"];
import { readdirSync } from "node:fs";
const med = (a) => { const s = [...a].filter((x) => x != null && !Number.isNaN(x)).sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN; };
const rng3 = (a, f = f0) => { const s = [...a].filter((x) => x != null && !Number.isNaN(x)).sort((x, y) => x - y); return s.length ? `${f(med(s))} (${f(s[0])}–${f(s[s.length - 1])})` : "-"; };
const files = (re) => readdirSync(dir).filter((f) => re.test(f)).map((f) => load(f));
const NAMES = { a: "A", a2: "A2", b: "B", c: "C", d: "D", e: "E", e2: "E2", a2ff: "A2ff", e2ff: "E2ff" };
const sections = {
  load() {
    const rows = ["a", "a2", "b", "c", "d", "e"].map((k) => load(`load.${k}.json`)).filter(Boolean).map((d) => [`**${NAMES[d.variant.key]}** ${d.variant.label.slice(3)}`, f0(d.timings.cellsMs), f0(d.cellsPerSecond), f0(d.sizes.heapMB), f0(d.sizes.indexMB), f0(d.sizes.totalMB), f0(d.bytesPerCell)]);
    return table(["Variant", "Insert 2M cells (ms)", "Cells/s", "Heap MB", "PK index MB", "Total MB", "Bytes/cell"], rows);
  },
  partition(set = "i1", keys = ["a", "a2", "b", "c", "d", "e"]) {
    return table(["p95 ms", ...keys.map((k) => NAMES[k])], READ.map((n) => [n, ...keys.map((k) => f0(p95(`read.${k}.${set}.json`, n)))]));
  },
  write(label = "i1", keys = ["a", "a2", "b", "c", "d", "e"]) {
    const rows = keys.map((k) => load(`write.${k}.${label}.json`)).filter(Boolean).map((d) => [NAMES[d.variant], f0(d.elapsedSec), f0(d.cellsPerSecond), f0(d.perChunk.totalMs.p50), f0(d.perChunk.totalMs.p95), f1(d.dbMsPerRowP95), f0(d.readersDuringWrites.p95), f0(d.userEditsDuringWrites.p95), f0(d.walMB), `${f0(d.sizeGrowth.heapMB + d.sizeGrowth.indexMB)}`, f1(d.hotUpdateRatio * 100) + "%", f0(d.deadlocks)]);
    return table(["Variant", "Seconds", "Cells/s", "Chunk p50 ms", "Chunk p95 ms", "DB ms/row p95", "Grid reads p95 ms", "Cell edit p95 ms", "WAL MB", "Growth MB", "HOT", "Deadlocks"], rows);
  },
  integrity(label = "i1", keys = ["a", "a2", "b", "c", "d", "e"]) {
    const rows = keys.map((k) => load(`write.${k}.${label}.json`)).filter(Boolean).map((d) => [NAMES[d.variant], f0(d.integrity.targetCellMismatches), f0(d.integrity.stuckInRunning), f0(d.integrity.duplicatePrimaryKeys), d.integrity.untouchedCellsUnchanged && d.integrity.targetCellsBeyondRangeUnchanged ? "yes" : "NO", d.integrity.userEditsApplied, `${d.casRace?.exactlyOneWinner}/${d.casRace?.trials}`, f0(d.contention?.lockWaitSamples), f0(d.contention?.deadlocks)]);
    return table(["Variant", "Wrong target cells", "Stuck running", "Duplicate keys", "Other cells unchanged", "User edits kept", "Same-cell race: one winner", "Lock waits (hot rows)", "Deadlocks"], rows);
  },
  indexes() {
    const sets = ["i0", "i1", "i2", "i3"];
    const names = ["window_random", "window_8_concurrent_clients", "sort_company_asc_top", "sort_company_asc_deep_offset", "sort_lead_score_desc_top", "sort_ai_summary_asc_deep_offset", "sort_company_prefix_key_top", "filter_state_error_window", "filter_value_equals_window", "filter_text_contains_window", "filter_numeric_gt_window", "filter_is_empty_window", "filter_found_email_sorted_by_company"];
    const read = table(["Read p95 ms (A2)", ...sets], names.map((n) => [n, ...sets.map((s) => f0(p95(`read.a2.${s}.json`, n)))]));
    const wrows = sets.map((s) => [s, load(`write.a2.${s}.json`), load(`indexes.a2.${s}.json`)]).filter(([, w]) => w).map(([s, w, ix]) => [s, f0(w.cellsPerSecond), f0(w.perChunk.totalMs.p95), f0(w.readersDuringWrites.p95), f1(w.hotUpdateRatio * 100) + "%", f0(w.walMB), f0(w.sizeGrowth.heapMB + w.sizeGrowth.indexMB), f0(ix?.indexTotalMB), f0(ix?.builds?.reduce((a, b) => a + b.createMs, 0) ?? 0)]);
    const write = table(["Write (A2)", "Cells/s", "Chunk p95 ms", "Grid reads p95 ms", "HOT", "WAL MB", "Growth MB", "Index MB (incl. PK)", "Index build ms"], wrows);
    return `${read}\n\n${write}`;
  },
  fillfactor() {
    const rows = [["a2", "i1"], ["a2ff", "i0"], ["a2ff", "i1"]].map(([k, l]) => [k, l, load(`write.${k}.${l}.json`)]).filter(([, , w]) => w).map(([k, l, w]) => [`${NAMES[k]} ${l}`, f0(w.cellsPerSecond), f0(w.perChunk.totalMs.p95), f1(w.hotUpdateRatio * 100) + "%", f0(w.walMB), f0(w.sizeGrowth.heapMB + w.sizeGrowth.indexMB), f0(w.deadTuplesAfter)]);
    return table(["Config", "Cells/s", "Chunk p95 ms", "HOT", "WAL MB", "Growth MB", "Dead tuples"], rows);
  },
  growth(keys = ["a2", "e2", "b", "d"]) {
    const names = ["window_random", "window_8_concurrent_clients", "sort_company_asc_top", "sort_company_asc_deep_offset", "sort_lead_score_desc_top", "sort_ai_summary_asc_deep_offset", "filter_state_error_window", "filter_value_equals_window", "filter_text_contains_window", "filter_numeric_gt_window", "filter_is_empty_window", "filter_found_email_sorted_by_company"];
    const g = keys.map((k) => load(`growth.${k}.big10.json`)).filter(Boolean);
    const head = table(["Variant", "Workbooks", "Cells in table", "Load (s)", "Heap+indexes MB"], g.map((d) => [NAMES[d.variant], f0(d.workbooks), f0(d.totalCells), f1(d.totalLoadSec), f0(d.sizes.totalMB)]));
    const warm = table(["p95 ms, warm, 12M cells", ...keys.map((k) => NAMES[k])], names.map((n) => [n, ...keys.map((k) => f0(p95(`read.${k}.grown.json`, n)))]));
    const cold = table(["p95 ms, after restart, 12M cells", ...keys.map((k) => NAMES[k])], names.map((n) => [n, ...keys.map((k) => f0(p95(`read.${k}.grown.cold.json`, n)))]));
    return `${head}\n\n${warm}\n\n${cold}`;
  },
  purge(keys = ["a2", "e2", "b", "d"]) {
    return table(["Variant", "Method", "Cells removed", "Purge ms", "WAL MB", "Dead tuples left"], keys.map((k) => load(`purge.${k}.grown.json`)).filter(Boolean).map((d) => [NAMES[d.variant], d.method, f0(d.cellsRemoved), f0(d.purgeMs), f0(d.walMB), f0(d.deadTuplesAfter)]));
  },
  partitions() {
    const dl = load("ddllock.d.fin.json");
    const pl = load("planning.d.fin.json");
    const rd = null;
    const out = [];
    if (dl) out.push(table(["List partitions: CREATE ... PARTITION OF while a grid reader runs", "ms"], [["Create one partition, p50", f1(dl.createPartitionMs.p50)], ["Create one partition, max", f1(dl.createPartitionMs.max)], ["Window read p95, no DDL", f1(dl.readerBaselineMs.p95)], ["Window read p95, during DDL", f1(dl.readerDuringDdlMs.p95)], ["Window read max, during DDL", f1(dl.readerDuringDdlMs.max)]]));
    if (pl) out.push(table([`Planning with ${pl.partitions} partitions`, "ms"], [["Planning time p50", f1(pl.planningMs.p50)], ["Planning time p95", f1(pl.planningMs.p95)], ["Execution time p95", f1(pl.executionMs.p95)]]));
    if (rd) out.push(table(["Window read p95 with ~540 partitions", "ms"], rd.suites[0].results.map((r) => [r.name, f0(r.summary.p95)])));
    return out.join("\n\n");
  },
  ctlWrites() {
    const cfgs = [["a2", "i1", "A2 (uuid ids) + i1"], ["e2", "i1", "E2 (bigint ids) + i1"], ["b", "i1", "B hash(workbook_id) x16 + i1"], ["d", "i1", "D list(workbook_id) + i1"], ["a2", "i0", "A2 + i0 (PK only)"], ["a2", "i2", "A2 + i2 (+ value-prefix index)"], ["a2", "i3", "A2 + i3 (+ covering index)"], ["a2ff", "i0", "A2 fillfactor 80 + i0"], ["a2ff", "i1", "A2 fillfactor 80 + i1"]];
    const rows = cfgs.map(([v, set, label]) => {
      const runs = files(new RegExp(`^write\\.${v}\\.ctl-${set}-r\\d+\\.json$`));
      if (!runs.length) return null;
      return [label, String(runs.length), rng3(runs.map((d) => d.cellsPerSecond)), rng3(runs.map((d) => d.perChunk.totalMs.p95)), rng3(runs.map((d) => d.readersDuringWrites.p95)), f1(med(runs.map((d) => d.hotUpdateRatio)) * 100) + "%", f0(med(runs.map((d) => d.walMB))), f0(med(runs.map((d) => d.sizeGrowth.heapMB + d.sizeGrowth.indexMB))), rng3(runs.map((d) => d.environment?.calibrationMs))];
    }).filter(Boolean);
    return table(["Configuration", "Rounds", "Cells/s, median (min–max)", "Chunk p95 ms", "Grid reads p95 ms", "HOT", "WAL MB", "Growth MB", "Host calibration ms"], rows);
  },
  ctlIndexReads() {
    const sets = ["i0", "i1", "i2", "i3"];
    const names = ["window_random", "window_8_concurrent_clients", "sort_company_asc_top", "sort_company_asc_deep_offset", "sort_lead_score_desc_top", "sort_ai_summary_asc_deep_offset", "sort_company_prefix_key_top", "filter_state_error_window", "filter_value_equals_window", "filter_text_contains_window", "filter_numeric_gt_window", "filter_is_empty_window", "filter_found_email_sorted_by_company"];
    const per = Object.fromEntries(sets.map((set) => [set, files(new RegExp(`^read\\.a2\\.ctl-${set}-r\\d+\\.json$`))]));
    const body = names.map((n) => [n, ...sets.map((set) => rng3(per[set].map((d) => d.suites[0].results.find((r) => r.name === n)?.summary.p95)))]);
    body.push(["host calibration ms", ...sets.map((set) => rng3(per[set].map((d) => d.environment?.calibrationMs)))]);
    return table(["A2 read p95 ms, median (min–max) of rounds", ...sets], body);
  },
  ctlGrowth() {
    const names = ["window_random", "window_8_concurrent_clients", "sort_company_asc_top", "sort_company_asc_deep_offset", "sort_lead_score_desc_top", "filter_state_error_window", "filter_value_equals_window", "filter_text_contains_window", "filter_found_email_sorted_by_company"];
    const keys = ["a2", "e2", "b", "d"];
    const get = (k, suffix) => [1, 2].map((p) => load(`read.${k}.ctl-grown-${p}${suffix}.json`)).filter(Boolean);
    const grid = (suffix, title) => table([title, ...keys.map((k) => NAMES[k])], names.map((n) => [n, ...keys.map((k) => rng3(get(k, suffix).map((d) => (d.suites ? d.suites[0] : d).results.find((r) => r.name === n)?.summary.p95)))]));
    const g = keys.map((k) => [1, 2].map((p) => load(`growth.${k}.ctl${p}.json`)).filter(Boolean)).map((x, i) => x.length ? [NAMES[keys[i]], String(x.length), f0(x[0].totalCells), rng3(x.map((d) => d.totalLoadSec), f0), f0(x[0].sizes.totalMB)] : null).filter(Boolean);
    return `${table(["Variant", "Passes", "Cells in table", "Load of 10M cells (s)", "Heap+indexes MB"], g)}\n\n${grid("", "Warm p95 ms, 12M cells, median (min–max) of passes")}\n\n${grid(".cold", "After container restart, p95 ms, 12M cells")}`;
  },
  ctlPurge() {
    const keys = ["a2", "e2", "b", "d"];
    const rows = keys.map((k) => [k, [1, 2].map((p) => load(`purge.${k}.ctl${p}.json`)).filter(Boolean)]).filter(([, x]) => x.length).map(([k, x]) => [NAMES[k], x[0].method, f0(x[0].cellsRemoved), rng3(x.map((d) => d.purgeMs)), f0(med(x.map((d) => d.walMB))), f0(med(x.map((d) => d.deadTuplesAfter)))]);
    return table(["Variant", "Method", "Cells removed", "Purge ms", "WAL MB", "Dead tuples left"], rows);
  },
  finWrites() {
    const cfgs = [["f", "i0", "**F** bigint ids + hash(workbook_id) x64 + fillfactor 80, no secondary index"], ["f", "i1", "F + state index `(column_id, state, row_id)`"], ["e2", "i1", "E2 bigint ids, unpartitioned, + state index (baseline)"]];
    const rows = cfgs.map(([v, set, label]) => {
      const runs = files(new RegExp(`^write\\.${v}\\.fin-${set}-r\\d+\\.json$`));
      if (!runs.length) return null;
      return [label, String(runs.length), rng3(runs.map((d) => d.cellsPerSecond)), rng3(runs.map((d) => d.perChunk.totalMs.p95)), rng3(runs.map((d) => d.readersDuringWrites.p95)), f1(med(runs.map((d) => d.hotUpdateRatio)) * 100) + "%", f0(med(runs.map((d) => d.walMB))), f0(med(runs.map((d) => d.sizeGrowth.heapMB + d.sizeGrowth.indexMB))), `${f0(Math.max(...runs.map((d) => Math.max(d.environment?.calibrationMs ?? 0, d.environment?.calibrationAfterMs ?? 0))))}`];
    }).filter(Boolean);
    return table(["Configuration", "Rounds", "Cells/s, median (min–max)", "Chunk p95 ms", "Grid reads p95 ms", "HOT", "WAL MB", "Growth MB", "Worst host probe ms"], rows);
  },
  finFull() {
    const f = load("write.f.fin-full.json");
    if (!f) return "";
    const i = f.integrity, x = f.contention, r = f.casRace;
    return table(["Full-size concurrent-update run, F (10 runs x 50,000 rows, 4 grid readers, 1 editor)", "Result"], [
      ["Cells updated / throughput", `${f0(f.cellsUpdated)} / ${f0(f.cellsPerSecond)} cells/s`],
      ["Database time per row, p95 (PRD: Skout's own processing under 50 ms/row)", `${f1(f.dbMsPerRowP95)} ms`],
      ["Updated cells with a wrong value", f0(i.targetCellMismatches)],
      ["Cells left in 'running'", f0(i.stuckInRunning)],
      ["Duplicate (row, column) keys", f0(i.duplicatePrimaryKeys)],
      ["All other cells byte-identical afterwards", i.untouchedCellsUnchanged && i.targetCellsBeyondRangeUnchanged ? `yes (${f0(i.untouchedCellsChecked)} checked)` : "NO"],
      ["Concurrent user edits kept", i.userEditsApplied],
      ["Row count before / after", `${f0(i.totalCellsBefore)} / ${f0(i.totalCellsAfter)}`],
      ["10 runs on the same 1,000 rows: chunk p95, lock waits, deadlocks", `${f0(x.totalMs.p95)} ms, ${f0(x.lockWaitSamples)}, ${f0(x.deadlocks)}`],
      ["Two runs claim the same cell: exactly one wins", `${r.exactlyOneWinner}/${r.trials}`],
    ]);
  },
  finGrowth() {
    const passes = [1, 2, 3].map((n) => [load(`read.f.fin-grown-i0-${n}.json`), load(`read.f.fin-grown-i0-${n}.cold.json`)]).filter(([w, c]) => w && c);
    const state = [load("read.f.fin-grown-i1-1.json"), load("read.f.fin-grown-i1-1.cold.json")];
    if (!passes.length) return "";
    const g = load("growth.f.fin-i0-1.json");
    const at = (suite, name) => (suite.suites ? suite.suites[0] : suite).results.find((r) => r.name === name)?.summary.p95;
    const names = passes[0][0].suites[0].results.map((r) => r.name);
    const probes = passes.map(([w]) => `${f0(w.environment.calibrationMs)}/${f0(w.environment.calibrationAfterMs)}`).join(", ");
    const head = `F, no secondary index, ${f0(g.totalCells)} cells in ${g.workbooks} workbooks (${f0(g.sizes.totalMB)} MB, ${g.sizes.partitions} partitions). ${passes.length} passes, each reloaded from scratch. Host probe before/after per pass: ${probes} ms. Pass 1 ran with the laptop on battery; passes 2 and 3 and the state-index run were on AC.\n\n`;
    const rows = names.map((n) => {
      const warm = passes.map(([w]) => at(w, n)), cold = passes.map(([, c]) => at(c, n));
      const target = passes[0][0].suites[0].results.find((r) => r.name === n).targetMs;
      const worst = Math.max(...warm, ...cold);
      return [n, f0(target), rng3(warm), rng3(cold), `${f0(at(state[0], n))} / ${f0(at(state[1], n))}`, `${f1((worst / target) * 100)}%`, worst <= target ? "PASS" : "FAIL"];
    });
    const purges = [1, 2, 3].map((n) => load(`purge.f.fin-i0-${n}.json`)).filter(Boolean);
    return head + table(["Case", "Target p95 ms", "Warm p95, median (min–max)", "After restart p95", "With state index (1 pass): warm / cold", "Worst of all passes vs target", "Result"], rows) + `\n\nPurging a 1,000,000-cell workbook (cascading DELETE inside its partition): ${rng3(purges.map((p) => p.purgeMs))} ms, ${f0(med(purges.map((p) => p.walMB)))} MB WAL, ${f0(purges[0].deadTuplesAfter)} dead tuples left for vacuum.`;
  },
  final() {
    const d = load("read.final.json");
    if (!d) return "";
    const names = Object.keys(d.p95AcrossRuns);
    return table(["Case", "Target p95", "p95 ms: median (min–max) of runs", "Pass"], names.map((n) => {
      const r = d.suites[0].results.find((x) => x.name === n);
      const med = d.p95AcrossRuns[n].median, max = d.p95AcrossRuns[n].max;
      return [n, r.targetMs ? `${f0(r.targetMs)} ms` : "-", p95Runs("read.final.json", n), r.targetMs ? (max <= r.targetMs ? "PASS" : med <= r.targetMs ? "PASS (a run exceeded)" : "FAIL") : "-"];
    }));
  },
};

const only = process.argv[2];
for (const [name, fn] of Object.entries(sections)) {
  if (only && only !== name) continue;
  console.log(`\n<!-- ${name} -->\n${fn()}\n`);
}
