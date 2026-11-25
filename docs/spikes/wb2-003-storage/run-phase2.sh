#!/usr/bin/env bash
# Phase 2: concurrent-update benchmark. Each variant is reloaded first so writes always start from the same
# pristine 100k x 20 workbook, then given the column index set. Run from packages/db with WB_SPIKE_DATABASE_URL set.
# (Correctness checks run earlier, on pristine data: `spike:wb2-003 verify --variant <v>`.)
set -uo pipefail
RUN="pnpm run --silent spike:wb2-003"
for v in "$@"; do
  echo "=== write $v: load"; $RUN load --variant "$v" --rows 100000 | grep -E '"(cellsPerSecond)"'
  echo "=== write $v: index set i1"; $RUN indexes --variant "$v" --set i1 | grep -E '"(totalMB)"'
  echo "=== write $v"; $RUN write --variant "$v" --workers 10 --rows-per-run 50000 --readers 4 --label i1
done
