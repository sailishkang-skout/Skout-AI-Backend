-- COPS-07: retention runs (dry run first, then apply). Idempotent: safe to run twice.

CREATE TABLE IF NOT EXISTS "cops_retention_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "mode" text NOT NULL,
  "status" text NOT NULL DEFAULT 'completed',
  "policy_version" integer NOT NULL,
  "counts" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "dry_run_id" uuid REFERENCES "cops_retention_runs"("id") ON DELETE SET NULL,
  "reason" text,
  "requested_by" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "cops_retention_runs_mode_ck" CHECK ("mode" IN ('dry_run', 'apply')),
  -- Deleting data always follows a dry run and carries a reason.
  CONSTRAINT "cops_retention_runs_apply_ck" CHECK ("mode" = 'dry_run' OR ("dry_run_id" IS NOT NULL AND "reason" IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS "cops_retention_runs_workspace_idx" ON "cops_retention_runs" ("workspace_id", "created_at");
