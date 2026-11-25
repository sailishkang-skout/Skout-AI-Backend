#!/usr/bin/env bash
# Phase 4: growth. Each variant starts from a pristine 100k x 20 workbook with the column index set, then gets
# 10 more workbooks of 50,000 rows (10M more cells, bigger than the instance's RAM), and is measured warm and
# after a container restart. Then a 1M-cell workbook is purged. List partitioning also gets 500 small workbooks,
# a partition-DDL-while-reading test and a planning-time probe.
# Run from packages/db with WB_SPIKE_DATABASE_URL set.
set -uo pipefail
RUN="pnpm run --silent spike:wb2-003"
for v in "$@"; do
  echo "=== $v: load + i1"; $RUN load --variant "$v" --rows 100000 | grep -E '"cellsPerSecond"'; $RUN indexes --variant "$v" --set i1 | grep -E '"totalMB"'
  echo "=== $v: growth (+10 x 50k rows)"; $RUN growth --variant "$v" --big 10 --big-rows 50000 --label big10 | grep -E '"(totalCells|workbooks|totalLoadSec|vacuumAnalyzeSec|totalMB)"'
  echo "=== $v: read warm"; $RUN read --variant "$v" --runs 1 --label grown --explain
  echo "=== $v: read cold"; $RUN read --variant "$v" --cold --label grown
  echo "=== $v: purge"; $RUN purge --variant "$v" --tag big0 --label grown
  if [ "$v" = d ]; then
    echo "=== $v: partition DDL while reading"; $RUN ddl-lock --variant "$v" --count 30 --label grown
    echo "=== $v: 500 small workbooks"; $RUN growth --variant "$v" --small 500 --small-rows 200 --label small500 | grep -E '"(totalCells|workbooks|smallWorkbooksLoadMsEach|partitions)"'
    echo "=== $v: planning time"; $RUN planning --variant "$v" --label small500
    echo "=== $v: read with ~540 partitions"; $RUN read --variant "$v" --runs 1 --label small500 --only '^window'
  fi
done
