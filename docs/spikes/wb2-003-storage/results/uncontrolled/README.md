# Uncontrolled runs (kept for the record, not used for conclusions)

Phases 3 and 4 ran on a shared laptop while earlier variants' bloat was still being vacuumed in the same database,
with no settle step or calibration probe. The same A2 workload loaded at 26k-86k cells/s depending on the hour, and
write throughput tracked it. Differences smaller than about 3x in these files are noise. They were re-measured with
`run-controlled.sh` (isolated schema, CHECKPOINT + autovacuum quiet, calibration probe, interleaved rounds).

## battery-throttled-session/
The first "controlled" write rounds. They ran while the laptop was on battery and draining to 1%; macOS throttled the
CPU part-way (round 1 ran at full speed, later rounds collapsed to 25-30% of it even where the pre-run calibration
probe looked normal). Re-run on AC power with a calibration probe before and after every run and automatic retry.
