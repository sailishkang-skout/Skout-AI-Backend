-- Phase 0 CRM bridge foundation: partial unique index enforcing at most one default
-- pipeline per workspace at the database level, closing the ensureDefaultPipeline() race
-- where two concurrent calls could both observe "no default pipeline exists" and each
-- insert one.
--
-- Environments may already have pre-existing duplicate default pipelines for a workspace
-- (exactly the bug this index fixes), which would make CREATE UNIQUE INDEX fail outright.
-- Deterministically demote all but the oldest default per workspace first so the index
-- creation always succeeds; safe and idempotent to re-run.
UPDATE "pipelines" p SET "is_default" = false
WHERE "is_default" = true
  AND EXISTS (
    SELECT 1 FROM "pipelines" q
    WHERE q."workspace_id" = p."workspace_id"
      AND q."is_default" = true
      AND (q."created_at", q."id") < (p."created_at", p."id")
  );
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pipelines_workspace_default_unique_idx" ON "pipelines" ("workspace_id") WHERE "is_default" = true;
