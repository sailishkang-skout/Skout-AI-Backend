CREATE TABLE IF NOT EXISTS "enrichment_identities" (
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "entity_type" text NOT NULL CHECK ("entity_type" IN ('person', 'company')),
  "canonical_key" text NOT NULL,
  "entity_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "enrichment_identities_pkey" PRIMARY KEY ("workspace_id", "entity_type", "canonical_key")
);

CREATE INDEX IF NOT EXISTS "enrichment_identities_workspace_entity_idx"
  ON "enrichment_identities" ("workspace_id", "entity_type", "entity_id");

CREATE TABLE IF NOT EXISTS "enrichment_capture_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('person', 'company', 'sales_search')),
  "source_url" text,
  "client_run_id" text,
  "status" text NOT NULL DEFAULT 'running'
    CHECK ("status" IN ('running', 'completed', 'stopped', 'failed', 'halted', 'rejected')),
  "pages_read" integer NOT NULL DEFAULT 0,
  "leads_received" integer NOT NULL DEFAULT 0,
  "leads_created" integer NOT NULL DEFAULT 0,
  "leads_merged" integer NOT NULL DEFAULT 0,
  "leads_rejected" integer NOT NULL DEFAULT 0,
  "error_code" text,
  "error_message" text,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz
);

CREATE INDEX IF NOT EXISTS "enrichment_capture_runs_workspace_started_idx"
  ON "enrichment_capture_runs" ("workspace_id", "started_at");
CREATE INDEX IF NOT EXISTS "enrichment_capture_runs_workspace_user_started_idx"
  ON "enrichment_capture_runs" ("workspace_id", "user_id", "started_at");
CREATE UNIQUE INDEX IF NOT EXISTS "enrichment_capture_runs_client_run_unique_idx"
  ON "enrichment_capture_runs" ("workspace_id", "user_id", "client_run_id")
  WHERE "client_run_id" IS NOT NULL;
