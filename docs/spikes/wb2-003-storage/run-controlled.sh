#!/usr/bin/env bash
# Controlled re-measurement. Phases 1-4 ran on a shared laptop with earlier variants' bloat still being vacuumed in
# the background, and the same workload loaded at 26k-86k cells/s depending on the hour. These runs fix that:
#   * every step first drops all other variant schemas (--exclusive) and waits for CHECKPOINT + autovacuum to go quiet
#   * every result carries a CPU calibration probe, so a slow stretch is visible
#   * configurations are interleaved over several rounds, rotating the order each round
# Run from packages/db with WB_SPIKE_DATABASE_URL set.   ./run-controlled.sh writes|indexes-read|growth
set -uo pipefail
RUN="pnpm run --silent spike:wb2-003"
RESULTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/results"
ROUNDS=${ROUNDS:-3}

# A run is valid only if the CPU calibration probe, measured before AND after it, stayed near the host's best.
# (Phases run on a laptop: the first controlled set was throttled as the battery drained, so an invalid run is retried.)
CAL_LIMIT=${CAL_LIMIT:-720}
valid() { node -e '
  const f=process.argv[1], lim=Number(process.argv[2]);
  try { const e=JSON.parse(require("fs").readFileSync(f,"utf8")).environment;
    process.exit(e && e.calibrationMs<=lim && e.calibrationAfterMs<=lim ? 0 : 1); } catch { process.exit(1); }' "$1" "$CAL_LIMIT"; }
with_retry() { # result-file command...
  local file=$1; shift; local tries=0
  until { "$@"; valid "$file"; } ; do tries=$((tries+1)); echo "   (host disturbed during $file, attempt $tries)"; [ $tries -ge 3 ] && { echo "   giving up: keeping last result, flagged invalid by its calibration"; break; }; done
}
rotate() { local n=$1; shift; local a=("$@"); local out=(); local len=${#a[@]}; for ((i=0;i<len;i++)); do out+=("${a[$(( (i+n) % len ))]}"); done; echo "${out[@]}"; }

case "${1:-}" in
writes)
  CONFIGS=(a2:i1 e2:i1 b:i1 d:i1 a2:i0 a2:i2 a2:i3 a2ff:i0 a2ff:i1)
  for r in $(seq 1 "$ROUNDS"); do
    for cfg in $(rotate $(( (r-1)*3 )) "${CONFIGS[@]}"); do
      v=${cfg%%:*}; set=${cfg##*:}
      echo "=== round $r  $v $set"
      with_retry "$RESULTS/write.$v.ctl-$set-r$r.json" bash -c "$RUN load --variant $v --rows 100000 --exclusive >/dev/null; $RUN indexes --variant $v --set $set >/dev/null; $RUN write --variant $v --workers 10 --rows-per-run 20000 --readers 4 --extras false --label ctl-$set-r$r | grep -E '\"(cellsPerSecond|hotUpdateRatio)\"'"
    done
  done ;;
indexes-read)
  # In place on one loaded A2: only the index set changes, so the data layout is identical across sets.
  echo "=== load a2"; $RUN load --variant a2 --rows 100000 --exclusive | grep -E '"cellsPerSecond"'
  SETS=(i0 i1 i2 i3)
  for r in $(seq 1 "$ROUNDS"); do
    for set in $(rotate $(( r-1 )) "${SETS[@]}"); do
      echo "=== round $r  a2 $set"
      $RUN indexes --variant a2 --set "$set" >/dev/null
      with_retry "$RESULTS/read.a2.ctl-$set-r$r.json" bash -c "$RUN read --variant a2 --runs 1 --label ctl-$set-r$r | tail -2"
    done
  done ;;
growth)
  CASES='^(window_random|window_8_concurrent_clients|sort_company_asc_top|sort_company_asc_deep_offset|sort_lead_score_desc_top|filter_state_error_window|filter_value_equals_window|filter_text_contains_window|filter_found_email_sorted_by_company)$'
  # Second pass reverses the uuid/bigint order to expose any order effect.
  for v in a2 e2 b d e2 a2; do
    tag=$v; [ -f "$RESULTS/growth.$v.ctl1.json" ] && tag=$v-pass2
    echo "=== growth $v ($tag)"
    $RUN load --variant "$v" --rows 100000 --exclusive | grep -E '"cellsPerSecond"'
    $RUN indexes --variant "$v" --set i1 >/dev/null
    $RUN growth --variant "$v" --big 10 --big-rows 50000 --label "$( [ "$tag" = "$v" ] && echo ctl1 || echo ctl2 )" | grep -E '"(totalCells|totalLoadSec|totalMB)"'
    n=$( [ "$tag" = "$v" ] && echo 1 || echo 2 )
    with_retry "$RESULTS/read.$v.ctl-grown-$n.json" bash -c "$RUN read --variant $v --runs 1 --label ctl-grown-$n --only '$CASES' | tail -3"
    $RUN read --variant "$v" --cold --label "ctl-grown-$( [ "$tag" = "$v" ] && echo 1 || echo 2 )" --only "$CASES" | tail -9
    $RUN purge --variant "$v" --tag big0 --label "ctl$( [ "$tag" = "$v" ] && echo 1 || echo 2 )" | grep -E '"(purgeMs|walMB)"'
  done ;;
*) echo "usage: $0 writes|indexes-read|growth" ;;
esac
