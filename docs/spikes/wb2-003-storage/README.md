# WB2-003 storage spike: how to reproduce

This folder holds the evidence for the Workbooks V2 storage decision. The decision itself is in
[`WB2-003-storage-decision.md`](./WB2-003-storage-decision.md). Raw results are in [`results/`](./results).

Nothing here is a production migration. The spike creates throwaway schemas (`wbs_<variant>`) in a
throwaway database and never touches the public schema or the legacy `enrichment_workbooks*` tables.
The tool refuses to run unless the database host is local and the database name contains `spike`.

## 1. Environment

Production RDS is `t4g.small` (2 vCPU, 2 GiB), Postgres 16 (`infra/lib/config/environments.ts`,
`skout-database.ts`). The container below is capped to match it:

```bash
docker run -d --name wb2003-pg --cpus=2 --memory=2g --shm-size=512m \
  -e POSTGRES_PASSWORD=spike -e POSTGRES_DB=skout_spike -p 55432:5432 postgres:16 \
  -c shared_buffers=512MB -c effective_cache_size=1GB -c work_mem=4MB -c maintenance_work_mem=64MB \
  -c max_wal_size=2GB -c min_wal_size=192MB -c random_page_cost=4 -c max_connections=200 \
  -c track_io_timing=on
```

Then apply the project's own migrations so the spike tables can reference the real `workspaces` and `users`:

```bash
export DATABASE_URL=postgresql://postgres:spike@localhost:55432/skout_spike
pnpm --filter @skout/db migrate && pnpm --filter @skout/db apply-pending && pnpm --filter @skout/db backfill-rbac
```

## 2. Run

```bash
cd packages/db
export WB_SPIKE_DATABASE_URL=postgresql://postgres:spike@localhost:55432/skout_spike
S="pnpm run --silent spike:wb2-003"

$S setup                                   # hash function + value dictionaries
$S load --variant a --rows 100000          # 100,000 rows x 20 columns = 2,000,000 cells (+ a 2,000-row workbook in a second workspace)
$S read --variant a --runs 3 --explain     # window / sort / filter benchmark, EXPLAIN ANALYZE saved next to the results
$S indexes --variant a --set i1            # i0 | i1 | i2 | i3 (see variants.ts)
$S write --variant a --workers 10          # concurrent runs + readers + edits + contention + compare-and-set race
$S verify --variant a                      # counts, constraints, isolation, sort/filter vs an independent JS oracle
$S growth --variant a --big 10 --big-rows 50000
$S purge --variant a --tag big0
$S ddl-lock --variant d                    # per-workbook partition DDL while readers run
$S read --variant a --cold                 # restarts the container first, then reads
```

Variants: `a` unpartitioned (PRD literal), `a2` unpartitioned + `workbook_id`, `b` hash(workbook_id) x16,
`c` hash(row_id) x16, `d` list(workbook_id), `e` unpartitioned with bigint ids, `a2ff`/`e2ff` fillfactor 80.

Scripts, in the order they were used:

* `run-phase1.sh`, `run-phase2.sh`, `run-phase3.sh`, `run-phase4.sh`: the first, **uncontrolled** pass (partitioning reads, writes, index sets, growth). Kept for the record; see `results/uncontrolled/README.md` for why they are not used for conclusions.
* `run-controlled.sh writes|indexes-read|growth`: the same comparisons re-run with isolated schemas, `CHECKPOINT` + autovacuum quiet, a CPU probe before and after each run, automatic retry of disturbed runs, and interleaved rounds. These are the numbers in the decision document.
* `run-final.sh verify|writes|growth|partitions`: the selected design (variant `f`) against its closest baseline, plus full-size verification of every variant.
* `node summarize.mjs [section]` prints the document's tables from `results/*.json`.

## 3. Tests

```bash
pnpm --filter @skout/db test                                   # unit tests always run
WB_SPIKE_DATABASE_URL=... pnpm --filter @skout/db exec vitest run src/spikes   # + the end-to-end smoke test on a 400-row workbook
```

## 4. Methodology notes

* **Data** is a pure function of (row, column, seed): a deterministic integer hash inside Postgres, md5-derived
  uuids, a fixed dictionary of values. No production data, no `random()`. Reloading gives an identical workbook.
* **Latency** is measured in the Node client around each `await`, so it includes the round trip through Docker's
  port forward and the cost of parsing a ~1 MB response (200 rows x 20 cells). Warm-up requests are discarded.
  Percentiles are nearest-rank. Benchmark inputs come from a seeded PRNG.
* **Repeats**: the final configuration is run 3 times; tables show the median of each run's p95 and the range.
* **What this does not model**: RDS network latency, EBS (gp3) IO limits, burst-credit throttling on `t4g`,
  Multi-AZ synchronous replication on writes (prod is Multi-AZ), and the app's own queries running at the same
  time. See the limitations section of the decision doc.
