#!/usr/bin/env bash
# Final candidate (F: bigint ids + hash(workbook_id) x64 + fillfactor 80) against the best alternatives, with the same
# controls as run-controlled.sh (isolated schema, settle, calibration before/after, automatic retry).
# Run from packages/db with WB_SPIKE_DATABASE_URL set.   ./run-final.sh verify|writes|growth|partitions
set -uo pipefail
RUN="pnpm run --silent spike:wb2-003"
RESULTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/results"
ROUNDS=${ROUNDS:-3}
CAL_LIMIT=${CAL_LIMIT:-720}
valid() { node -e '
  const f=process.argv[1], lim=Number(process.argv[2]);
  try { const e=JSON.parse(require("fs").readFileSync(f,"utf8")).environment;
    process.exit(e && e.calibrationMs<=lim && e.calibrationAfterMs<=lim ? 0 : 1); } catch { process.exit(1); }' "$1" "$CAL_LIMIT"; }
with_retry() { local file=$1; shift; local tries=0
  until { "$@"; valid "$file"; }; do tries=$((tries+1)); echo "   (host disturbed during $file, attempt $tries)"; [ $tries -ge 3 ] && { echo "   giving up: flagged invalid by its calibration"; break; }; done; }
rotate() { local n=$1; shift; local a=("$@"); local out=(); local len=${#a[@]}; for ((i=0;i<len;i++)); do out+=("${a[$(( (i+n) % len ))]}"); done; echo "${out[@]}"; }

case "${1:-}" in
verify) # correctness on pristine data, for the final candidate
  for v in a a2 b c d e e2 f; do echo "=== verify $v"; $RUN load --variant "$v" --rows 100000 --exclusive >/dev/null; $RUN verify --variant "$v" --rows 100000; done ;;
writes) # concurrent updates: F with and without the state index, against the unpartitioned bigint baseline
  CONFIGS=(f:i0 f:i1 e2:i1)
  for r in $(seq 1 "$ROUNDS"); do
    for cfg in $(rotate $(( r-1 )) "${CONFIGS[@]}"); do
      v=${cfg%%:*}; set=${cfg##*:}; echo "=== final round $r  $v $set"
      with_retry "$RESULTS/write.$v.fin-$set-r$r.json" bash -c "$RUN load --variant $v --rows 100000 --exclusive >/dev/null; $RUN indexes --variant $v --set $set >/dev/null; $RUN write --variant $v --workers 10 --rows-per-run 20000 --readers 4 --extras false --label fin-$set-r$r | grep -E '\"(cellsPerSecond|hotUpdateRatio)\"'"
    done
  done
  # Full-size run with contention and compare-and-set checks for the final candidate.
  echo "=== final: full write run with contention + race checks (f i0)"
  $RUN load --variant f --rows 100000 --exclusive >/dev/null; $RUN indexes --variant f --set i0 >/dev/null
  $RUN write --variant f --workers 10 --rows-per-run 50000 --readers 4 --label fin-full | grep -E '"(cellsPerSecond|deadlocks|targetCellMismatches|exactlyOneWinner|lockWaitSamples)"' ;;
growth) # 12M cells: F (two index sets) x3 passes, warm and after restart
  CASES='^(window_random|window_8_concurrent_clients|sort_company_asc_top|sort_company_asc_deep_offset|sort_lead_score_desc_top|filter_state_error_window|filter_value_equals_window|filter_text_contains_window|filter_found_email_sorted_by_company)$'
  for pass in 1 2 3; do
    for set in i0 i1; do
      [ "$pass" -gt 1 ] && [ "$set" = i1 ] && continue   # i1 once; the chosen i0 three times
      echo "=== final growth f $set pass $pass"
      $RUN load --variant f --rows 100000 --exclusive | grep -E '"cellsPerSecond"'; $RUN indexes --variant f --set "$set" >/dev/null
      $RUN growth --variant f --big 10 --big-rows 50000 --label "fin-$set-$pass" | grep -E '"(totalCells|totalLoadSec|totalMB)"'
      with_retry "$RESULTS/read.f.fin-grown-$set-$pass.json" bash -c "$RUN read --variant f --runs 1 --label fin-grown-$set-$pass --only '$CASES' | tail -3"
      $RUN read --variant f --cold --label fin-grown-$set-$pass --only "$CASES" | tail -3
      $RUN purge --variant f --tag big0 --label "fin-$set-$pass" | grep -E '"(purgeMs|walMB)"'
    done
  done ;;
partitions) # why not one partition per workbook: DDL while readers run, and planning with ~540 partitions (D)
  $RUN load --variant d --rows 100000 --exclusive >/dev/null; $RUN indexes --variant d --set i1 >/dev/null
  $RUN ddl-lock --variant d --count 30 --label fin | grep -E '"(p50|p95|max)"'
  $RUN growth --variant d --small 500 --small-rows 200 --label fin-small500 | grep -E '"(workbooks|partitions)"'
  $RUN planning --variant d --label fin ;;
*) echo "usage: $0 verify|writes|growth|partitions" ;;
esac
