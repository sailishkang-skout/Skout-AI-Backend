-- COPS-10: durable delays. A delay step waits as pending with run_after set; it is not claimed
-- before then, and the run worker's sweep re-enqueues runs whose waiting steps are due, so a
-- delay survives a restart or a lost queue job.
ALTER TABLE "automation_run_steps" ADD COLUMN IF NOT EXISTS "run_after" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automation_run_steps_due_idx" ON "automation_run_steps" ("run_after") WHERE "status" = 'pending' AND "run_after" IS NOT NULL;
