/**
 * WB2-003 storage spike CLI.
 *
 *   pnpm --filter @skout/db spike:wb2-003 <command> [--variant a] [--rows 100000] ...
 *
 * Needs a throwaway Postgres (see docs/spikes/wb2-003-storage/README.md). Refuses to run against any
 * database whose name does not contain "spike" or whose host is not local.
 */
import { appliedIndexes, calibrate, connect, restartSpikeContainer, saveResult, saveText, settle } from "./db.js";
import { applyIndexSet } from "./indexes.js";
import { MAIN_ROWS, dropOtherVariants, dropVariant, loadVariant, setupGenerator } from "./load.js";
import { explainSuite, p95Across, runReadSuite } from "./bench-read.js";
import { runWriteBench } from "./bench-write.js";
import { addGrowth, ddlLockTest, planningTime, purgeWorkbook } from "./growth.js";
import { btreeLimitProbe, runVerify } from "./verify.js";
import { type IndexSetKey, VARIANTS, variantByKey } from "./variants.js";

function parseArgs(argv: string[]) {
  const [command = "help", ...rest] = argv;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) continue;
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) flags.set(a.slice(2), "true");
    else {
      flags.set(a.slice(2), next);
      i++;
    }
  }
  return { command, flags };
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const sql = connect(8);
  try {
    const variants = (flags.get("variant") ?? "").split(",").filter(Boolean).map(variantByKey);
    const rows = Number(flags.get("rows") ?? MAIN_ROWS);
    switch (command) {
      case "setup":
        await setupGenerator(sql);
        console.log("generator ready");
        break;
      case "load":
        for (const v of variants) {
          if (flags.get("exclusive") === "true") await dropOtherVariants(sql, v);
          console.log(`loading ${v.label} (${rows} rows)...`);
          console.log(JSON.stringify(await loadVariant(sql, v, rows), null, 1));
        }
        break;
      case "indexes":
        for (const v of variants) {
          const set = (flags.get("set") ?? "i1") as IndexSetKey;
          console.log(JSON.stringify(await applyIndexSet(sql, v, set), null, 1));
        }
        break;
      case "read": {
        const runs = Number(flags.get("runs") ?? 1);
        const only = flags.get("only") ? new RegExp(flags.get("only")!) : undefined;
        for (const v of variants) {
          const applied = (await appliedIndexes(sql, v)).map((n) => n.replace(/^workbook_cells_|_idx$/g, "")).join("+");
          const label = flags.get("label") ?? (applied || "i0");
          if (flags.get("cold") === "true") {
            await sql.end();
            await restartSpikeContainer();
            return await coldRun(v.key, rows, label, only);
          }
          const environment = flags.get("no-settle") === "true" ? null : { settleMs: await settle(sql), calibrationMs: await calibrate(sql) };
          const suites: Awaited<ReturnType<typeof runReadSuite>>[] = [];
          for (let r = 0; r < runs; r++) {
            console.log(`read bench ${v.key} [${label}] run ${r + 1}/${runs}`);
            suites.push(await runReadSuite(sql, v, rows, 1000 + r, only));
          }
          const names = suites[0]!.results.map((x) => x.name);
          const p95 = Object.fromEntries(names.map((n) => [n, p95Across(suites, n)]));
          const envAfter = environment ? { ...environment, calibrationAfterMs: await calibrate(sql) } : null;
          saveResult(`read.${v.key}.${label}`, { variant: v.key, label, runs, environment: envAfter, p95AcrossRuns: p95, suites });
          if (flags.get("explain") === "true") saveText(`explain.${v.key}.${label}.txt`, await explainSuite(sql, v, rows));
          for (const n of names) {
            const r0 = suites[0]!.results.find((x) => x.name === n)!;
            console.log(`${n.padEnd(40)} p50 ${r0.summary.p50.toFixed(1).padStart(8)}  p95 ${r0.summary.p95.toFixed(1).padStart(8)}  (runs p95 ${p95[n]!.min}..${p95[n]!.max})`);
          }
        }
        break;
      }
      case "verify":
        for (const v of variants) {
          const r = await runVerify(sql, v, rows);
          for (const c of r.checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name} - ${c.detail}`);
          console.log(`${v.key}: ${r.passed} passed, ${r.failed} failed`);
          if (r.failed) process.exitCode = 1;
        }
        console.log(`btree limit probe: ${await btreeLimitProbe(sql)}`);
        break;
      case "write":
        for (const v of variants) {
          const label = flags.get("label") ?? "run";
          const environment = flags.get("no-settle") === "true" ? null : { settleMs: await settle(sql), calibrationMs: await calibrate(sql) };
          const r = await runWriteBench(sql, v, rows, { workers: Number(flags.get("workers") ?? 10), rowsPerRun: Number(flags.get("rows-per-run") ?? 50_000), readers: Number(flags.get("readers") ?? 4) }, label, flags.get("extras") !== "false", environment, () => calibrate(sql));
          console.log(JSON.stringify({ ...r, perChunk: { claimP95: r.perChunk.claimMs.p95, completeP95: r.perChunk.completeMs.p95, totalP50: r.perChunk.totalMs.p50, totalP95: r.perChunk.totalMs.p95 }, readersDuringWrites: r.readersDuringWrites.p95, userEditsDuringWrites: r.userEditsDuringWrites.p95 }, null, 1));
        }
        break;
      case "growth":
        for (const v of variants) {
          const opts = { big: Number(flags.get("big") ?? 0), bigRows: Number(flags.get("big-rows") ?? 50_000), small: Number(flags.get("small") ?? 0), smallRows: Number(flags.get("small-rows") ?? 200) };
          console.log(JSON.stringify(await addGrowth(sql, v, opts, flags.get("label") ?? "grown"), null, 1));
        }
        break;
      case "purge":
        for (const v of variants) console.log(JSON.stringify(await purgeWorkbook(sql, v, flags.get("tag") ?? "big0", flags.get("label") ?? "run"), null, 1));
        break;
      case "ddl-lock":
        for (const v of variants) console.log(JSON.stringify(await ddlLockTest(sql, v, rows, Number(flags.get("count") ?? 30), flags.get("label") ?? "run"), null, 1));
        break;
      case "planning":
        for (const v of variants) console.log(JSON.stringify(await planningTime(sql, v, rows, flags.get("label") ?? "run"), null, 1));
        break;
      case "drop":
        for (const v of variants) await dropVariant(sql, v);
        break;
      default:
        console.log(`commands: setup | load | drop   variants: ${VARIANTS.map((v) => v.key).join(",")}`);
    }
  } finally {
    await sql.end();
  }
}

async function coldRun(key: string, rows: number, label: string, only?: RegExp) {
  const sql = connect(8);
  try {
    const v = variantByKey(key);
    const suite = await runReadSuite(sql, v, rows, 5000, only, false);
    saveResult(`read.${key}.${label}.cold`, { ...suite, coldStart: "container restarted, no warm-up queries" });
    for (const r of suite.results) console.log(`${r.name.padEnd(40)} p50 ${r.summary.p50.toFixed(1).padStart(8)}  p95 ${r.summary.p95.toFixed(1).padStart(8)}  max ${r.summary.max.toFixed(1)}`);
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
