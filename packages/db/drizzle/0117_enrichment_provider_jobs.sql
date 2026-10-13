CREATE TABLE IF NOT EXISTS "enrichment_provider_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "external_account_id" text NOT NULL,
  "credential_ref" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'paused', 'revoked')),
  "capabilities" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "last_checked_at" timestamptz,
  "last_error_code" text,
  "connected_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "enrichment_provider_connections_account_unique" UNIQUE ("workspace_id", "provider", "external_account_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enrichment_provider_connections_workspace_status_idx"
  ON "enrichment_provider_connections" ("workspace_id", "provider", "status");
--> statement-breakpoint
ALTER TABLE "enrichment_jobs" ALTER COLUMN "activation_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "enrichment_jobs"
  ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'contact_waterfall',
  ADD COLUMN IF NOT EXISTS "target_type" text,
  ADD COLUMN IF NOT EXISTS "source_url" text,
  ADD COLUMN IF NOT EXISTS "normalized_url" text,
  ADD COLUMN IF NOT EXISTS "provider" text,
  ADD COLUMN IF NOT EXISTS "provider_connection_id" uuid REFERENCES "enrichment_provider_connections"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "correlation_id" uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS "idempotency_key" text,
  ADD COLUMN IF NOT EXISTS "attempt_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "max_attempts" integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "lease_expires_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "error_code" text,
  ADD COLUMN IF NOT EXISTS "result" jsonb,
  ADD COLUMN IF NOT EXISTS "requested_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "test_mode" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "enrichment_jobs_idempotency_key_unique_idx"
  ON "enrichment_jobs" ("workspace_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
--> statement-breakpoint
-- At most one unfinished provider job per LinkedIn URL in a workspace.
CREATE UNIQUE INDEX IF NOT EXISTS "enrichment_jobs_active_linkedin_url_unique_idx"
  ON "enrichment_jobs" ("workspace_id", "normalized_url")
  WHERE "kind" = 'linkedin_profile' AND "status" IN ('queued', 'running');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enrichment_jobs_kind_status_next_attempt_idx"
  ON "enrichment_jobs" ("kind", "status", "next_attempt_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enrichment_jobs_workspace_kind_queued_idx"
  ON "enrichment_jobs" ("workspace_id", "kind", "queued_at");
