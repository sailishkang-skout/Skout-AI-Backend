-- ENR-01 follow-up: enrichment_attempts was the one enrichment table without workspace_id. Attempts
-- hold raw provider responses (evidence), so they carry the tenant key like every other row instead
-- of being reachable only through enrichment_jobs.
-- migration-safety: SET NOT NULL runs after every row is backfilled from its parent job (attempts
-- cascade-delete with the job, so no attempt is without one). Re-runnable: each step is guarded.
ALTER TABLE "enrichment_attempts" ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE;
--> statement-breakpoint
UPDATE "enrichment_attempts" a
  SET "workspace_id" = j."workspace_id"
  FROM "enrichment_jobs" j
  WHERE j."id" = a."enrichment_job_id" AND a."workspace_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "enrichment_attempts" ALTER COLUMN "workspace_id" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enrichment_attempts_workspace_job_idx"
  ON "enrichment_attempts" ("workspace_id", "enrichment_job_id");
