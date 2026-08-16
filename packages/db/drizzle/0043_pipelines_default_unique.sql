-- Phase 0 CRM bridge foundation: partial unique index enforcing at most one default
-- pipeline per workspace at the database level, closing the ensureDefaultPipeline() race
-- where two concurrent calls could both observe "no default pipeline exists" and each
-- insert one.
CREATE UNIQUE INDEX IF NOT EXISTS "pipelines_workspace_default_unique_idx" ON "pipelines" ("workspace_id") WHERE "is_default" = true;
