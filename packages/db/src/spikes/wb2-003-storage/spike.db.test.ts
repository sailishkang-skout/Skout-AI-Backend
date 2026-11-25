/**
 * End-to-end check of the spike machinery on a small dataset, for every storage variant. Needs the throwaway
 * Postgres from docs/spikes/wb2-003-storage/README.md (WB_SPIKE_DATABASE_URL, database name containing "spike");
 * skipped everywhere else, including CI. Uses its own schema prefix and results folder, so it cannot touch
 * recorded benchmark data.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, type Sql } from "./db.js";
import { dropVariant, loadVariant, setupGenerator } from "./load.js";
import { runWriteBench } from "./bench-write.js";
import { runReadSuite } from "./bench-read.js";
import { btreeLimitProbe, runVerify } from "./verify.js";
import { VARIANTS } from "./variants.js";

const url = process.env.WB_SPIKE_DATABASE_URL;
const enabled = Boolean(url && /spike/i.test(url));
const ROWS = 400;

describe.skipIf(!enabled)("WB2-003 storage spike (small dataset, every variant)", () => {
  let sql: Sql;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wb-spike-"));
    process.env.WB_SPIKE_RESULTS_DIR = dir;
    process.env.WB_SPIKE_SCHEMA_PREFIX = "wbstest_";
    sql = connect(12);
    await setupGenerator(sql);
  });

  afterAll(async () => {
    for (const v of VARIANTS) await dropVariant(sql, v);
    await sql.end();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.WB_SPIKE_RESULTS_DIR;
    delete process.env.WB_SPIKE_SCHEMA_PREFIX;
  });

  for (const v of VARIANTS) {
    it(`${v.key}: loads ${ROWS} rows x 20 columns and passes every verification check`, async () => {
      const loaded = await loadVariant(sql, v, ROWS);
      expect(loaded.counts).toMatchObject({ rows: ROWS, cells: ROWS * 20, columns: 20 });
      const verified = await runVerify(sql, v, ROWS);
      expect(verified.checks.filter((c) => !c.pass)).toEqual([]);
      expect(verified.checks.length).toBeGreaterThan(20);
    }, 120_000);

    it(`${v.key}: concurrent runs update only their own cells and lose nothing`, async () => {
      const r = await runWriteBench(sql, v, ROWS, { workers: 4, rowsPerRun: 300, readers: 1 }, "test", true);
      expect(r.integrity).toMatchObject({
        targetCellMismatches: 0,
        stuckInRunning: 0,
        duplicatePrimaryKeys: 0,
        untouchedCellsUnchanged: true,
        targetCellsBeyondRangeUnchanged: true,
        totalCellsAfter: r.integrity.totalCellsBefore,
      });
      expect(r.deadlocks).toBe(0);
      expect(r.casRace).toMatchObject({ bothClaimed: 0, neitherClaimed: 0, exactlyOneWinner: 300 });
      expect(r.cellsUpdated).toBe(4 * 300);
    }, 120_000);
  }

  it("the read benchmark runs end to end and reports latencies", async () => {
    const v = VARIANTS[0]!;
    await loadVariant(sql, v, ROWS);
    const suite = await runReadSuite(sql, v, ROWS, 1, /^(window_first|sort_company_asc_top|filter_state_error_count)$/);
    expect(suite.results.map((r) => r.name)).toEqual(["window_first", "sort_company_asc_top", "filter_state_error_count"]);
    for (const r of suite.results) {
      expect(r.summary.n).toBeGreaterThan(5);
      expect(r.summary.p95).toBeGreaterThan(0);
    }
  }, 120_000);

  it("documents the btree entry size limit with a real failure", async () => {
    expect(await btreeLimitProbe(sql)).toMatch(/index row (size|requires)/i);
  });
});
