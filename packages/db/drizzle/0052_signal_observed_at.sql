-- Completes the Signal entity's time fields: the vision doc asks for source/observed-time/
-- detection-time as distinct fields, but the original table (0028_signals.sql) only had one
-- timestamp (detected_at). Adds observed_at — when the real-world event happened, which can
-- predate detection (e.g. a job posting scraped days after it went live).

ALTER TABLE "signals" ADD COLUMN IF NOT EXISTS "observed_at" timestamp with time zone;
