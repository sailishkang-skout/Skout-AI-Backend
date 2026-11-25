#!/usr/bin/env bash
# Phase 1: every storage variant, loaded with the same 100k x 20 workbook, read-benchmarked with the PRD-minimum
# indexes (i0) and with the column index set (i1). Run from packages/db with WB_SPIKE_DATABASE_URL set.
set -euo pipefail
RUN="pnpm run --silent spike:wb2-003"
for v in "$@"; do
  echo "=== $v: load"; $RUN load --variant "$v" --rows 100000 | grep -E '"(cellsMs|cellsPerSecond|totalMB|bytesPerCell)"'
  echo "=== $v: read i0"; $RUN read --variant "$v" --runs 1 --label i0 --explain
  echo "=== $v: index set i1"; $RUN indexes --variant "$v" --set i1 | grep -E '"(createMs|sizeMB|totalMB)"'
  echo "=== $v: read i1"; $RUN read --variant "$v" --runs 1 --label i1 --explain
done
