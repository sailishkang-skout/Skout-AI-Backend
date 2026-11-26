# Workbooks V2 rows: performance at 100,000 rows (WB2-012)

## Result

| Target | Slowest scenario, p95 (run 1 / run 2) | Met |
|---|--:|---|
| 200-row window under 300 ms p95 | 125 ms / 120 ms | yes |
| Sort, filter and search over all rows under 1,500 ms p95 | 1132 ms / 1105 ms | yes |

Measured on a laptop, not on production hardware.

## Method

`apps/api/src/routes/workbook-v2-rows.bench.test.ts` (data: `apps/api/src/test/workbook-rows-dataset.ts`).

```bash
# a throwaway database with migrations, apply-pending, RBAC backfill and model versions applied
cd apps/api
CI=true ROWS_BENCHMARK=1 DATABASE_URL=postgresql://…/wb_bench ROWS_BENCHMARK_REPORT=report.json \
  npx vitest run src/routes/workbook-v2-rows.bench.test.ts
```

`CI=true` stops a `pretest` step from touching a local development database; the benchmark does not run in normal test runs.

- **Data:** one workbook of 100,000 rows × 20 columns = 2,000,000 cells (1,538,219 with a value; 7 input, 8 enrichment, 2 formula, 2 AI, 1 action column; enrichment cells in a mix of states), beside 5 workbooks of 20,000 rows in other workspaces. Values are a fixed function of row and column. `VACUUM (ANALYZE)` after loading.
- **Measurement:** real HTTP on localhost against the listening server, including sign-in, feature-switch and permission checks, the queries, JSON serialisation and reading the whole response. 3 warm-up requests, then the number of samples in brackets. Warm cache.
- **Environment:** PostgreSQL 16.15 in a container limited to 2 CPUs and 2 GiB, `shared_buffers` 512 MB, `work_mem` 4 MB (filtered and sorted queries raise it to 32 MB for their transaction), 2 parallel workers; Node 24; Apple M-series laptop on battery.

## 200-row windows

| Scenario | Run 1 p50 / p95 / max (ms) | Run 2 p50 / p95 / max (ms) |
|---|--:|--:|
| first 200 rows, 20 columns (100) | 26 / **35** / 50 | 27 / **36** / 48 |
| 200 rows at spread offsets, 20 columns (100) | 33 / **52** / 119 | 32 / **45** / 82 |
| last 200 rows (offset 99,800), 20 columns (100) | 45 / **53** / 68 | 42 / **69** / 103 |
| 200 rows at spread offsets, 8 columns (100) | 27 / **65** / 137 | 27 / **41** / 63 |
| 200 rows, 5 concurrent requests (100) | 85 / **125** / 150 | 84 / **120** / 140 |

A 200 × 20 response is about 785 KB; 8 columns, about 337 KB.

## Sort, filter, search (200 rows returned, all 100,000 considered)

| Scenario | Matching rows | Run 1 p50 / p95 / max (ms) | Run 2 p50 / p95 / max (ms) |
|---|--:|--:|--:|
| sort by text column (50) | 100,000 | 109 / **122** / 123 | 91 / **104** / 130 |
| sort by text column, deep offset 90,000 (50) | 100,000 | 208 / **277** / 305 | 194 / **217** / 272 |
| sort by long unique text (50) | 100,000 | 141 / **237** / 291 | 106 / **140** / 153 |
| sort by number column (50) | 100,000 | 126 / **224** / 401 | 100 / **127** / 146 |
| sort by sparse enrichment column (50) | 100,000 | 111 / **167** / 201 | 88 / **109** / 166 |
| sort by 3 columns (50) | 100,000 | 154 / **218** / 261 | 121 / **131** / 157 |
| sort by 3 columns, last page (50) | 100,000 | 395 / **490** / 511 | 376 / **417** / 455 |
| sort by row source (50) | 100,000 | 44 / **63** / 81 | 47 / **51** / 53 |
| filter contains (50) | 16,672 | 218 / **387** / 424 | 146 / **165** / 170 |
| filter number greater than (50) | 19,847 | 165 / **205** / 213 | 175 / **202** / 267 |
| filter is empty (50) | 42,163 | 162 / **183** / 307 | 131 / **162** / 172 |
| filter has value (50) | 57,837 | 162 / **185** / 189 | 131 / **142** / 176 |
| filter does not contain (50) | 96,700 | 192 / **282** / 352 | 198 / **212** / 252 |
| filter state, one column (50) | 6,011 | 182 / **237** / 305 | 136 / **327** / 468 |
| filter state, any column (50) | 49,614 | 292 / **341** / 374 | 206 / **309** / 422 |
| filter row source (50) | 10,022 | 40 / **50** / 55 | 45 / **50** / 58 |
| filter matching nothing (50) | 0 | 73 / **85** / 167 | 86 / **106** / 147 |
| filter + sort (50) | 79,170 | 426 / **482** / 875 | 402 / **466** / 579 |
| 5 filters + 3 sorts (50) | 20,026 | 229 / **259** / 284 | 218 / **260** / 284 |
| 10 filters + 3 sorts (request maximum) (50) | 58,110 | 1047 / **1132** / 1184 | 1033 / **1105** / 1196 |
| search, common word (50) | 10,507 | 344 / **384** / 418 | 360 / **409** / 525 |
| search, rare value (50) | 57 | 331 / **372** / 403 | 361 / **393** / 419 |
| search, no match (50) | 0 | 308 / **341** / 345 | 313 / **349** / 396 |
| search, one character (matches most rows) (50) | 100,000 | 234 / **285** / 351 | 184 / **205** / 336 |
| search + filter + sort (50) | 2,527 | 359 / **412** / 499 | 363 / **392** / 396 |

The benchmark also checks that the top of a sort and a filter's match count equal what direct SQL over all cells gives.

## Writes (no target; for reference)

Measured before the audit entry was added to row deletes, which adds one insert per delete request.

| Scenario | Run 1 p50 / p95 / max (ms) | Run 2 p50 / p95 / max (ms) |
|---|--:|--:|
| bulk add 1,000 rows x 7 input cells (20) | 340 / **387** / 403 | 308 / **322** / 325 |
| add one row (30) | 20 / **26** / 26 | 19 / **21** / 25 |
| edit one cell (30) | 8 / **12** / 12 | 6 / **9** / 10 |
| delete one row (30) | 18 / **23** / 24 | 18 / **21** / 25 |
| delete 1,000 rows (15) | 51 / **62** / 62 | 53 / **61** / 61 |

## Query plans and bottlenecks

Full plans are in the JSON report. `EXPLAIN (ANALYZE, BUFFERS)` from run 1:

| Query | Database time | How it is answered |
|---|--:|---|
| window at offset 99,800 | 26 ms | Sorts the workbook's 100,000 row ids and skips to the offset |
| sort by text column | 94 ms | One scan of the workbook's cell partition for the column, hash join, top-200 heap sort |
| sort by 3 columns | 115 ms | Sort on the first column, then primary-key lookups for the others |
| filter number greater than | 132 ms | Primary-key lookup of the column's cell for each of 100,000 rows |
| filter state, any column | 256 ms | Semi-join over each row's cells until one matches |
| 5 filters + 3 sorts | 205 ms | One primary-key join per filtered or sorted column |
| search, common word | 305 ms | Parallel scan of the cell partition testing every value, then the matching rows |
| count only (page past the last match) | 308 ms | Same as search, count only |
| cells of one window | 1 ms | Primary key: 4,000 cells |

- **Search is bound by a scan.** It reads every cell in the workbook's partition (about 280 of 305 ms), so it grows with the amount of data in that partition and slows with fewer free CPU cores. WB2-003 approved no text index; a trigram index would help rare terms and cost writes. Revisit if search nears the target in production.
- **Each filtered or sorted column is one more join.** The request maximum (10 filters and 3 sort keys) is the slowest case at about 1.1 s, leaving the least headroom.
- **One pass per filtered request.** The page query also returns the match count (`count(*) OVER ()`). An earlier version counted separately and a search took 600–900 ms in an exploratory run on the same data size.
- **Deep offsets** cost a sort of everything before them. Positions are gapped on purpose: keeping them contiguous made a delete rewrite later rows (about 0.4 s at 100,000 rows in a trial).
- No index was added. Reads use the WB2-010 keys: the cell primary key `(workbook_id, row_id, column_id)` and the row index `(workbook_id, position)`.

## Not measured

Cold cache, production hardware and network, many concurrent sorts or searches, workbooks with more than 20 columns, a workbook queried before autovacuum has analysed freshly imported data, and a partition holding many large workbooks.
