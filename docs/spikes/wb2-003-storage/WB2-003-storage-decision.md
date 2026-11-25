# WB2-003: storage decision for Workbooks V2

Status: spike complete for the acceptance criteria; three gaps are listed in [Limitations](#10-limitations-and-open-items). Reproduction steps: [README.md](./README.md). Reference DDL for WB2-010: [recommended-schema.sql](./recommended-schema.sql). Raw results: [results/](./results).

## 1. Decision

Use this for the WB2-010 migrations (variant **F** in the spike):

| Decision | Choice | Why (measured) |
|---|---|---|
| Partitioning | `workbook_cells` partitioned by **hash(workbook_id), 64 partitions** | A sort or filter on one column must read every cell of that column. Unpartitioned, that reads the whole table; partitioned, only the workbook's own partition. Unpartitioned uuid filter+sort went from 0.2 s to **1.0–1.3 s** as the table grew from 2M to 12M cells. 64 partitions need no per-workbook DDL. |
| Primary key | `(workbook_id, row_id, column_id)` | Postgres requires the partition column in the key, so PRD §9's `(row_id, column_id)` cannot be created on a table partitioned by `workbook_id` (§3.1). |
| Cell ↔ workbook link | `workbook_id` on every cell, with composite FKs to rows and columns | In the PRD-literal schema a cell can join a row of workbook A to a column of workbook B. The composite FKs refuse it (§3.2, verified). |
| Row ids | `workbook_rows.id` **bigint identity** (columns stay uuid) | ~15% fewer bytes per cell, +12% concurrent write throughput, and filter+sort at 12M cells 4–5x faster than unpartitioned uuid (§6). |
| Cell heap | **fillfactor 80** on each cell partition, **no secondary index** on `workbook_cells` | Leaves room for HOT updates: 94% HOT, 40% less WAL (147 vs 243 MB) and 6 MB of heap growth instead of 33 MB per 200,000-cell write run (§5). |
| Row/column indexes | `workbook_rows (workbook_id, position)` (PRD), `workbook_columns (workbook_id, position)` | Window reads are 1,200 buffer hits and 2.4 ms (§7). |
| Never | An index on raw `value` | A btree entry over 2,704 bytes is refused; reproduced in §3.3. AI text can exceed it. |
| Optional later | `(column_id, state, row_id)` | State filters ~3x faster at 2M cells (69 → 22 ms), but writes −14%, HOT 94% → 0%, WAL +65%. Not needed to meet any target. Add it when a product need appears. |

**PRD targets: all pass** for the selected design at 12M cells (6x the 100k x 20 workbook), warm and after a restart (§6).

## 2. Environment and method

* **Database**: PostgreSQL 16.15 in Docker on an Apple M3 laptop, capped to production's instance: `--cpus=2 --memory=2g`, `shared_buffers=512MB`, `effective_cache_size=1GB`, `work_mem=4MB`, `max_wal_size=2GB`, `random_page_cost=4` (RDS `t4g.small`, Postgres 16, from `infra/lib/config/environments.ts`). The project's own 166 migrations were applied so the spike tables reference the real `workspaces` and `users`. The legacy `enrichment_workbooks*` tables are untouched.
* **Isolation**: each variant lives in its own schema (`wbs_<key>`) in a throwaway database; the tool refuses to run unless the host is local and the database name contains `spike`.
* **Data**: 100,000 rows x 20 columns = **2,000,000 cells** (7 input, 8 enrichment, 2 formula, 2 AI, 1 action column), generated inside Postgres from a deterministic hash, so a reload is identical. State mix on the enrichment columns: found 58%, not found 14%, queued 8%, running 1%, error 6%, skipped 9%, needs input 4%; 15% of found enrichment cells are cache hits; `internal_provenance` is set exactly where `found_via = skout`. A second 2,000-row workbook in a second workspace is loaded for isolation checks. No production data.
* **Measurement**: client-side latency around each query (includes Docker port-forward and parsing a ~1 MB response). Nearest-rank percentiles, seeded inputs, warm-up discarded (kept for cold runs). "Cold" means the container was restarted so `shared_buffers` is empty; the VM page cache may still help.
* **A lesson that shaped the evidence.** The laptop is not a quiet host. The same workload loaded at 26k–86k cells/s in different sessions, and my first write comparisons were wrong because earlier variants' dead tuples were still being vacuumed in the same database and the laptop throttled as its battery drained. So: (1) every comparison below was **re-run with isolated schemas, `CHECKPOINT` + autovacuum quiet, a CPU probe before and after each run (a run is invalid if either probe exceeds 720 ms; the quiet baseline is 530–600 ms) and automatic retry**, interleaved over 3 rounds with the order rotated; (2) the earlier uncontrolled runs are kept in `results/uncontrolled/` and **not used for conclusions** except where the effect is far larger than the noise (variant C, §4). Absolute throughput differs between stages (the final stage ran with the host probe at up to 665 ms), so compare configurations only within a table.

## 3. Findings that change PRD §9

### 3.1 The primary key cannot be created as written
`PRIMARY KEY (row_id, column_id)` on a table partitioned by `workbook_id` is rejected: every unique key on a partitioned table must contain the partition columns. Options measured: partition by `row_id` (keeps the PRD key; **fails the window target**, §4), or add `workbook_id` to the key (chosen).

### 3.2 Nothing stops a cell joining two workbooks' data
With only `(row_id, column_id)` keys, `INSERT ... (row of workbook A, column of workbook B)` succeeds (verified on variants A, C, E). With `workbook_id` on the cell and composite FKs it fails with a foreign-key violation (verified on A2, B, D, E2, F). This is a tenant-isolation defect worth closing in the schema, not only in application code.

### 3.3 A raw btree on the cell value fails on long text
```
index row size 3240 exceeds btree version 4 maximum 2704 for index "probe_c_v_idx"
```
Reproduced by `spike:wb2-003 verify` (a 3.2 KB incompressible value). AI summary columns can reach that size, so a `(column_id, value)` index would make some inserts fail.

### 3.4 Sort and filter cost scales with the table, unless the table is partitioned or clustered
With the PRD's indexes, a sort by one column plans to read all cells and keep one column's: 39,648 buffers (~310 MB) for a 100k-row workbook in a 2M-cell table; the window read touches 1,264 buffers. At 2M cells that is ~90 ms; it only stayed fast because everything was cached. Partitioning by workbook turns that scan into a scan of the workbook's own partition.

## 4. Partitioning comparison

Variants (all hold the same 100k x 20 workbook): **A** unpartitioned, PRD-literal · **A2** + `workbook_id` · **B** hash(workbook_id) x16 · **C** hash(row_id) x16 · **D** list(workbook_id), one partition per workbook · **E** unpartitioned, bigint ids · **E2** bigint + `workbook_id` · **F** bigint + hash(workbook_id) x64.

Initial pass, 2M cells, warm, one run each (uncontrolled: only differences larger than ~3x mean anything). Bulk insert of 2M cells with keys and foreign keys in place, and sizes:

| Variant | Insert 2M cells (ms) | Cells/s | Heap MB | PK index MB | Total MB | Bytes/cell |
|---|---:|---:|---:|---:|---:|---:|
| **A** unpartitioned, PRD literal | 20,966 | 95,392 | 265 | 124 | 389 | 204 |
| **A2** unpartitioned + workbook_id | 22,353 | 89,474 | 297 | 124 | 421 | 221 |
| **B** hash(workbook_id) x16 | 25,205 | 79,350 | 297 | 175 | 473 | 248 |
| **C** hash(row_id) x16 | 22,281 | 89,762 | 265 | 125 | 390 | 204 |
| **D** list(workbook_id), one per workbook | 23,845 | 83,875 | 297 | 175 | 473 | 248 |
| **E** unpartitioned, bigint ids | 18,257 | 109,545 | 250 | 80 | 330 | 173 |

Read p95 (ms), column index set `i1`, same pass:

| p95 ms | A | A2 | B | C | D | E |
|---|---:|---:|---:|---:|---:|---:|
| window_random | 17 | 11 | 13 | 234 | 11 | 11 |
| window_first | 13 | 10 | 11 | 303 | 10 | 18 |
| window_last | 16 | 13 | 18 | 229 | 14 | 16 |
| window_8_concurrent_clients | 100 | 82 | 83 | 1,438 | 65 | 101 |
| sort_company_asc_top | 115 | 77 | 79 | 334 | 80 | 77 |
| sort_company_asc_deep_offset | 215 | 179 | 214 | 402 | 180 | 295 |
| sort_lead_score_desc_top | 89 | 81 | 77 | 309 | 73 | 76 |
| sort_ai_summary_asc_deep_offset | 338 | 227 | 264 | 449 | 289 | 414 |
| filter_state_error_window | 18 | 20 | 22 | 199 | 22 | 24 |
| filter_value_equals_window | 60 | 60 | 109 | 290 | 84 | 96 |
| filter_text_contains_window | 175 | 193 | 140 | 261 | 110 | 75 |
| filter_numeric_gt_window | 36 | 38 | 47 | 297 | 65 | 25 |
| filter_is_empty_window | 22 | 28 | 24 | 269 | 26 | 16 |
| filter_found_email_sorted_by_company | 88 | 181 | 190 | 527 | 204 | 136 |

**C is eliminated**: window p95 212–303 ms single-client and 1.4–1.7 s with 8 clients against 10–18 ms for every other variant, and about 3x slower writes in the uncontrolled pass. Hashing by `row_id` spreads one window's 200 rows over all 16 partitions. A, A2, B, D, E are indistinguishable at 2M cells. The differences appear with growth (§6).

Concurrent updates, controlled (§5). Maintenance: list partitioning drops a workbook in 0.8 s with 10 MB WAL where a cascading `DELETE` takes 2.4–5.2 s and ~200 MB WAL, but it needs a partition per workbook (creating one took ~10 ms and did not stall readers: window p95 11.7 → 16.5 ms while 30 partitions were created; planning with 542 partitions was 0.1 ms; measured in an earlier session as a within-run comparison). Hash x64 needs no runtime DDL and bounds the partition count, which is why F uses it. If purge cost becomes a problem, per-workbook list partitions are the measured alternative.

## 5. Indexing comparison and concurrent updates

Read p95 (ms) on A2 (2M cells, warm), index sets measured in place on the same loaded data, median (min–max) of 3 rounds: `i0` PK only · `i1` + `(column_id, state, row_id)` · `i2` + `(column_id, left(value #>> '{}', 64), row_id)` · `i3` + covering `(column_id, row_id) INCLUDE (state, value)`:

| A2 read p95 ms, median (min–max) of rounds | i0 | i1 | i2 | i3 |
|---|---:|---:|---:|---:|
| window_random | 11 (10–11) | 11 (11–12) | 12 (11–13) | 10 (10–12) |
| window_8_concurrent_clients | 74 (71–75) | 73 (73–73) | 76 (74–77) | 73 (72–75) |
| sort_company_asc_top | 92 (83–95) | 79 (73–81) | 83 (81–92) | 87 (84–89) |
| sort_company_asc_deep_offset | 182 (182–192) | 183 (170–184) | 182 (173–203) | 181 (172–204) |
| sort_lead_score_desc_top | 75 (75–76) | 71 (69–74) | 75 (73–83) | 75 (73–79) |
| sort_ai_summary_asc_deep_offset | 231 (223–245) | 238 (212–271) | 228 (220–233) | 230 (217–267) |
| sort_company_prefix_key_top | 87 (78–96) | 83 (82–89) | 82 (76–85) | 78 (75–78) |
| filter_state_error_window | 69 (66–80) | 22 (22–22) | 26 (21–29) | 25 (21–26) |
| filter_value_equals_window | 76 (68–78) | 65 (64–72) | 76 (61–86) | 67 (62–82) |
| filter_text_contains_window | 94 (89–101) | 89 (84–130) | 91 (89–96) | 110 (88–112) |
| filter_numeric_gt_window | 39 (36–39) | 40 (36–56) | 38 (36–41) | 44 (43–49) |
| filter_is_empty_window | 24 (23–25) | 29 (24–44) | 26 (25–27) | 24 (23–27) |
| filter_found_email_sorted_by_company | 197 (180–201) | 223 (173–251) | 169 (166–174) | 178 (169–187) |
| host calibration ms | 541 (537–574) | 538 (536–552) | 538 (535–545) | 540 (537–557) |

Only the state filter benefits (69 → 22–26 ms). None of the sets helps a sort, because the value still has to come from the heap, and `i2`/`i3` buy nothing.

Concurrent updates: 10 runs, each its own column, 20,000 rows per run in chunks of 100 rows, every chunk = a claim (compare-and-set into `running`) and a result write, as separate commits; 4 grid readers and a user editing input cells at the same time. 3 rounds, order rotated, host probes within limits:

| Configuration | Rounds | Cells/s, median (min–max) | Chunk p95 ms | Grid reads p95 ms | HOT | WAL MB | Growth MB | Host calibration ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| A2 (uuid ids) + i1 | 3 | 10,940 (7,383–11,191) | 100 (96–248) | 56 (51–113) | 0% | 352 | 83 | 542 (534–588) |
| E2 (bigint ids) + i1 | 3 | 12,301 (11,939–12,524) | 77 (75–78) | 36 (36–37) | 0% | 245 | 54 | 542 (537–543) |
| B hash(workbook_id) x16 + i1 | 3 | 10,543 (10,475–11,290) | 106 (98–106) | 66 (57–67) | 0% | 377 | 87 | 585 (557–629) |
| D list(workbook_id) + i1 | 3 | 11,517 (10,934–11,542) | 100 (96–103) | 62 (51–65) | 0% | 376 | 86 | 537 (529–538) |
| A2 + i0 (PK only) | 3 | 12,602 (12,242–12,707) | 78 (77–78) | 39 (38–42) | 55.9% | 228 | 34 | 552 (537–568) |
| A2 + i2 (+ value-prefix index) | 3 | 9,414 (8,912–10,213) | 127 (109–143) | 77 (70–82) | 0% | 466 | 110 | 536 (535–541) |
| A2 + i3 (+ covering index) | 3 | 9,055 (8,524–9,223) | 154 (149–166) | 89 (86–93) | 0% | 511 | 150 | 545 (536–583) |
| A2 fillfactor 80 + i0 | 3 | 13,079 (12,816–13,102) | 75 (74–76) | 40 (39–41) | 93.2% | 177 | 7 | 536 (533–545) |
| A2 fillfactor 80 + i1 | 3 | 11,245 (11,142–11,946) | 96 (90–98) | 56 (54–57) | 0.1% | 336 | 65 | 545 (541–557) |

* Every secondary index on a column that updates change (`state`, `value`) ends HOT updates and adds WAL. Throughput: PK only 12.6k > `i1` 10.9k (−13%) > `i2` 9.4k > `i3` 9.1k cells/s.
* Partitioning is a wash for writes (A2 10.9k, B 10.5k, D 11.5k cells/s). Bigint ids are +12% with 30% less WAL.
* Fillfactor 80 alone does nothing if `state` is indexed (A2ff+i1 11.2k vs 10.9k); it pays off only with no secondary index (13.1k cells/s, 93% HOT).

Final candidate against its closest baseline, 3 interleaved rounds (final stage):

| Configuration | Rounds | Cells/s, median (min–max) | Chunk p95 ms | Grid reads p95 ms | HOT | WAL MB | Growth MB | Worst host probe ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **F** bigint ids + hash(workbook_id) x64 + fillfactor 80, no secondary index | 3 | 10,165 (8,526–10,471) | 99 (97–136) | 50 (49–69) | 94.3% | 147 | 6 | 663 |
| F + state index `(column_id, state, row_id)` | 3 | 8,759 (8,137–8,948) | 133 (123–134) | 63 (62–69) | 0.1% | 243 | 33 | 665 |
| E2 bigint ids, unpartitioned, + state index (baseline) | 3 | 9,303 (7,981–9,725) | 108 (107–138) | 54 (50–67) | 0% | 245 | 55 | 618 |

Integrity, full-size run of the selected design (10 concurrent runs x 50,000 rows) and other variants' integrity checks (all pass, §8):

| Full-size concurrent-update run, F (10 runs x 50,000 rows, 4 grid readers, 1 editor) | Result |
|---|---:|
| Cells updated / throughput | 500,000 / 9,521 cells/s |
| Database time per row, p95 (PRD: Skout's own processing under 50 ms/row) | 1.2 ms |
| Updated cells with a wrong value | 0 |
| Cells left in 'running' | 0 |
| Duplicate (row, column) keys | 0 |
| All other cells byte-identical afterwards | yes (900,000 checked) |
| Concurrent user edits kept | 590/590 |
| Row count before / after | 2,040,000 / 2,040,000 |
| 10 runs on the same 1,000 rows: chunk p95, lock waits, deadlocks | 35 ms, 0, 0 |
| Two runs claim the same cell: exactly one wins | 300/300 |

## 6. PRD targets at scale

Selected design (F, no secondary index) with **12,040,000 cells in 12 workbooks (2.8 GB, larger than the instance's 2 GiB RAM)**, warm and after a container restart:

F, no secondary index, 12,040,000 cells in 12 workbooks (2,757 MB, 64 partitions). Host probe 583 / 620 ms.

| Case | Target p95 ms | Warm p95 | After restart p95 | Worst vs target | Result |
|---|---:|---:|---:|---:|---:|
| window_random | 300 | 16 | 23 | 7.5% | PASS |
| window_8_concurrent_clients | 300 | 92 | 166 | 55.2% | PASS |
| sort_company_asc_top | 1,500 | 203 | 308 | 20.5% | PASS |
| sort_company_asc_deep_offset | 1,500 | 613 | 817 | 54.4% | PASS |
| sort_lead_score_desc_top | 1,500 | 243 | 550 | 36.7% | PASS |
| filter_state_error_window | 1,500 | 247 | 302 | 20.2% | PASS |
| filter_value_equals_window | 1,500 | 223 | 208 | 14.9% | PASS |
| filter_text_contains_window | 1,500 | 642 | 410 | 42.8% | PASS |
| filter_found_email_sorted_by_company | 1,500 | 566 | 603 | 40.2% | PASS |

Purging a 1,000,000-cell workbook (cascading DELETE inside its partition): 5,161 ms, 200 MB WAL, 1,050,021 dead tuples left for vacuum.

Controlled growth comparison of the alternatives at the same size (A2 uuid unpartitioned, E2 bigint unpartitioned, B hash x16, D list), median (min–max) of passes. A2 and E2 ran twice in opposite order to expose order effects:

| Variant | Passes | Cells in table | Load of 10M cells (s) | Heap+indexes MB |
|---|---:|---:|---:|---:|
| A2 | 2 | 12,040,000 | 215 (215–268) | 3,347 |
| E2 | 2 | 12,040,000 | 166 (166–167) | 3,096 |
| B | 1 | 12,040,000 | 206 (206–206) | 3,647 |
| D | 1 | 12,040,000 | 192 (192–192) | 3,645 |

| Warm p95 ms, 12M cells, median (min–max) of passes | A2 | E2 | B | D |
|---|---:|---:|---:|---:|
| window_random | 34 (34–48) | 15 (15–16) | 37 (37–37) | 31 (31–31) |
| window_8_concurrent_clients | 172 (172–186) | 84 (84–93) | 102 (102–102) | 91 (91–91) |
| sort_company_asc_top | 135 (135–178) | 126 (126–214) | 178 (178–178) | 124 (124–124) |
| sort_company_asc_deep_offset | 282 (282–312) | 229 (229–263) | 295 (295–295) | 282 (282–282) |
| sort_lead_score_desc_top | 119 (119–303) | 164 (164–170) | 183 (183–183) | 154 (154–154) |
| filter_state_error_window | 45 (45–47) | 35 (35–96) | 44 (44–44) | 48 (48–48) |
| filter_value_equals_window | 154 (154–374) | 121 (121–220) | 190 (190–190) | 171 (171–171) |
| filter_text_contains_window | 117 (117–251) | 134 (134–171) | 101 (101–101) | 114 (114–114) |
| filter_found_email_sorted_by_company | 1,005 (1,005–1,315) | 205 (205–233) | 283 (283–283) | 268 (268–268) |

| After container restart, p95 ms, 12M cells | A2 | E2 | B | D |
|---|---:|---:|---:|---:|
| window_random | 26 (26–28) | 14 (14–17) | 23 (23–23) | 20 (20–20) |
| window_8_concurrent_clients | 104 (104–151) | 81 (81–91) | 86 (86–86) | 85 (85–85) |
| sort_company_asc_top | 205 (205–213) | 113 (113–182) | 163 (163–163) | 151 (151–151) |
| sort_company_asc_deep_offset | 254 (254–442) | 229 (229–280) | 282 (282–282) | 241 (241–241) |
| sort_lead_score_desc_top | 122 (122–189) | 116 (116–117) | 105 (105–105) | 197 (197–197) |
| filter_state_error_window | 53 (53–77) | 34 (34–37) | 33 (33–33) | 39 (39–39) |
| filter_value_equals_window | 165 (165–171) | 107 (107–117) | 122 (122–122) | 106 (106–106) |
| filter_text_contains_window | 131 (131–137) | 107 (107–114) | 186 (186–186) | 101 (101–101) |
| filter_found_email_sorted_by_company | 433 (433–702) | 174 (174–190) | 300 (300–300) | 258 (258–258) |

Purge of a 1,000,000-cell workbook:

| Variant | Method | Cells removed | Purge ms | WAL MB | Dead tuples left |
|---|---:|---:|---:|---:|---:|
| A2 | DELETE FROM workbooks (cascade through rows, columns, cells) | 1,000,000 | 4,087 (4,087–4,333) | 208 | 1,050,021 |
| E2 | DELETE FROM workbooks (cascade through rows, columns, cells) | 1,000,000 | 2,446 (2,446–2,661) | 201 | 1,050,021 |
| B | DELETE FROM workbooks (cascade through rows, columns, cells) | 1,000,000 | 3,402 (3,402–3,402) | 208 | 1,050,021 |
| D | DETACH + DROP the workbook's partition, then DELETE the workbook (rows cascade) | 1,000,000 | 799 (799–799) | 10 | 0 |

Reading across the three: unpartitioned uuid (A2) is the only design whose worst case (filter+sort, 1.0–1.3 s) approaches 1.5 s, and it gets worse as the table grows. Bigint ids (E2, 205 ms) or workbook partitioning (B 283 ms, D 268 ms) fix it. F combines both. F (no secondary index) is slower than B and E2 on some queries at 12M cells: state filter about 5–7x (247 vs 35–48 ms), text filter about 5–6x (642 vs 101–134 ms), deep sort about 2–3x (613 vs 229–295 ms). The design differs in several ways at once (index set, fillfactor, partition count), so the cause was not isolated. It still passes every target, worst case 817 ms (cold) against 1,500 ms, and keeps HOT updates. The state index was not measured for F at this size (§10).

## 7. Query plans

* **Window** (`workbook_rows (workbook_id, position)` range, then the primary key for each row's 20 cells): 1,264 buffer hits, 2.4 ms execution, 8 for the row index and 1,256 for the cells. The primary key on `(workbook_id, row_id, column_id)` serves this lookup with the workbook_id predicate (partition pruned to one partition).
* **Sort / filter**: the database does the work. Plans show a top-N sort or index-ordered node under a `Limit`, and the client receives one window (4,000 cell rows), not 100k rows; verified in `verify`. Full plans: `results/explain.*.txt`.
* **Response size**: a 200 x 20 window is ~1 MB of JSON; a sizeable part of the 15–40 ms is transfer and parsing. The API should send only visible columns.

## 8. Verification

| Variant | Checks | Passed | Failed |
|---|---:|---:|---:|
| A | 31 | 31 | 0 |
| A2 | 32 | 32 | 0 |
| B | 32 | 32 | 0 |
| C | 31 | 31 | 0 |
| D | 32 | 32 | 0 |
| E | 31 | 31 | 0 |
| E2 | 32 | 32 | 0 |
| F | 32 | 32 | 0 |

Each row is a variant loaded with the full 100,000 rows and 2,000,000 cells. The checks include: row, column and cell counts; no duplicate keys; no orphan cells; foreign-key and CHECK violations rejected; the state mix; `internal_provenance` set exactly for `found_via = skout`; windows of workbook A return only A's rows and workbook B's only B's; a window carries no `internal_provenance`; sorting by another workbook's column leaks nothing; deleting a workspace cascades to its workbook, rows and cells and nothing else (rolled back); **sorting all 100k rows by a text column equals an independent JS sort row for row**; numeric-sort windows at offsets straddling tie-group boundaries equal the JS order; each of five filters (state, equality, text contains, numeric range, is-empty) returns the same count and first window as a JS oracle over all 100k rows.

Tests: `pnpm --filter @skout/db test` (unit tests always; 22 DB-backed tests with `WB_SPIKE_DATABASE_URL` set load every variant at 400 rows, run the full verification and a concurrent-update run on each).

A bug the oracle caught: the first sorted-window query returned the right 200 rows in position order instead of sort order. Windows inside a tie group hid it at 100k rows; it is fixed (`ORDER BY p.sort_key ...`) and pinned by a unit test and by checks at tie-group boundaries. Latencies measured before the fix used the old final ordering (200 rows x 20 cells; negligible cost); the final-stage numbers (§5 final, §6 F) use the fixed query.

## 9. What WB2-010 needs to do

1. Hand-write the migration from `recommended-schema.sql` (drizzle-kit cannot generate `PARTITION BY`), add it to the journal, and declare the tables as ordinary `pgTable`s. The migration runs in one transaction (fine for `CREATE TABLE ... PARTITION OF`; no `CONCURRENTLY`).
2. Select an explicit column list in every browser-bound read; never `SELECT *` from cells. Consider a view without `internal_provenance` for the read path.
3. Always filter cells by `workbook_id` (partition pruning and tenant isolation).
4. Expose opaque ids to the browser if sequential row ids are a concern.
5. Purge soft-deleted workbooks in a background job (a 1M-cell cascading delete takes ~5 s and ~200 MB WAL); consider batching, and tune autovacuum on the cell partitions.
6. Do not index `state`, `value` or `confidence` without re-measuring: every such index ends HOT updates.

## 10. Limitations and open items

1. **The selected design's 12M-cell run was done once, not three times.** The laptop lost power twice during the final stage. Its writes (3 rounds), the full-size integrity run and the 12M-cell reads (one pass, warm and cold) are measured; the alternatives' 12M-cell runs have 1–2 passes. The 3x repeat is complete for the write comparisons and for the 2M-cell index comparison.
2. **F with the state index was not measured at 12M cells.** Its writes were (3 rounds). The decision to leave it out rests on F-without-index already passing every target and on the write cost; add it if state filters need the headroom.
3. **Partition-DDL and planning results (§4) come from an earlier, uncontrolled session.** They compare "during DDL" to "no DDL" inside one run, so host drift largely cancels, but they were not re-run under the final controls.
4. **Not modelled**: RDS network latency, EBS (gp3) IO limits, `t4g` burst-credit throttling, Multi-AZ synchronous replication (production is Multi-AZ, which adds commit latency to every write), the application's own queries, other tenants' concurrent imports (sequential ids interleave when imports run at the same time, which may weaken clustering; the hash partitioning does not depend on it), and real provider latency.
5. **Single-writer host noise**: two stages ran with host probes up to 665 ms against a 530–600 ms quiet baseline; the retry rule caught one disturbed run. A few valid runs still show a slow outlier (for example one A2+i1 run at 7.4k cells/s against 10.4–11.2k for the others); the tables report medians and ranges.
6. **Insert speed** (§4) is one run per variant with ±30% variation between reloads; use it only to see that 2M cells load in 21–35 s server-side (PRD import target: 100k rows visible in under 2 minutes, which also includes parsing and mapping).
7. **Data model gaps**: `workbook_runs`, `workbook_imports`, `workbook_views` and `workbook_webhooks` were created but not benchmarked; `prospect_id` has no foreign key; `credits_charged` is an integer.
8. The spike code lives in `packages/db/src/spikes/wb2-003-storage/` (type-checked and tested like the rest of the package, but not part of the product). It can be deleted once WB2-010 lands.
