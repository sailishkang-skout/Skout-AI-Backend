-- COPS-10: a run records what started it (trigger payload) and what it is about (subject, for
-- example an account), so run history can be read per workflow, version or account.
ALTER TABLE "automation_runs" ADD COLUMN IF NOT EXISTS "trigger_payload" jsonb;
--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN IF NOT EXISTS "subject_type" text;
--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN IF NOT EXISTS "subject_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automation_runs_version_idx" ON "automation_runs" ("automation_version_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automation_runs_subject_idx" ON "automation_runs" ("workspace_id", "subject_type", "subject_id", "created_at");
