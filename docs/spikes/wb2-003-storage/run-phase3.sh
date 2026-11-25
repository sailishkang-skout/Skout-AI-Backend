#!/usr/bin/env bash
# Phase 3: index sets and fillfactor. Every step reloads a pristine workbook first.
# Run from packages/db with WB_SPIKE_DATABASE_URL set.
set -uo pipefail
RUN="pnpm run --silent spike:wb2-003"
step() { # variant set label [read]
  local v=$1 set=$2 label=$3 doread=${4:-yes}
  echo "=== $v $set ($label): load"; $RUN load --variant "$v" --rows 100000 | grep -E '"cellsPerSecond"'
  echo "=== $v $set ($label): indexes"; $RUN indexes --variant "$v" --set "$set" | grep -E '"(createMs|sizeMB|totalMB)"'
  if [ "$doread" = yes ]; then echo "=== $v $set ($label): read"; $RUN read --variant "$v" --runs 1 --label "$label" --explain; fi
  echo "=== $v $set ($label): write"; $RUN write --variant "$v" --workers 10 --rows-per-run 50000 --readers 4 --label "$label" --extras false
}
# 1. Which secondary indexes? (A2, uuid ids). i1 already measured in phases 1-2.
for set in i0 i2 i3; do step a2 "$set" "$set"; done
# 2. Bigint ids with workbook_id (the smallest tuples), i1 baseline.
step e2 i1 i1
# 3. Fillfactor 80 leaves room for HOT updates: with no indexed column in the update (i0) and with i1.
step a2ff i0 i0 no
step a2ff i1 i1 no
# 4. Variance check on the slowest variant of phase 2.
step d i1 i1-rerun no
