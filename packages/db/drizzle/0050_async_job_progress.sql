-- Adds a 0-100 progress column to async_jobs so long-running jobs (e.g. workspace ICP
-- rescore) can be surfaced as a visible, pollable progress indicator instead of just
-- pending/running/completed.

ALTER TABLE "async_jobs" ADD COLUMN IF NOT EXISTS "progress" integer;
