-- PAPI-058: batch jobs keep their input and results inline (up to 1,000 small items). Results are
-- deleted with the job row 7 days after it finishes (JOB-2, maintenance job).
ALTER TABLE "api_jobs" ADD COLUMN IF NOT EXISTS "input" jsonb;
--> statement-breakpoint
ALTER TABLE "api_jobs" ADD COLUMN IF NOT EXISTS "results" jsonb;
