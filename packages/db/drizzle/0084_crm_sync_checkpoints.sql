CREATE TABLE "crm_sync_checkpoints" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "connection_id" UUID NOT NULL REFERENCES "crm_connections"("id") ON DELETE CASCADE,
  "entity_type" TEXT NOT NULL,
  "cursor" TIMESTAMPTZ,
  "last_run_status" TEXT NOT NULL DEFAULT 'never_run',
  "last_run_started_at" TIMESTAMPTZ,
  "last_run_completed_at" TIMESTAMPTZ,
  "last_error" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "crm_sync_checkpoints_connection_entity_uidx" UNIQUE ("connection_id", "entity_type")
);
--> statement-breakpoint
CREATE INDEX "crm_sync_checkpoints_workspace_idx" ON "crm_sync_checkpoints" ("workspace_id");
--> statement-breakpoint
CREATE TABLE "crm_native_links" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "connection_id" UUID NOT NULL REFERENCES "crm_connections"("id") ON DELETE CASCADE,
  "entity_type" TEXT NOT NULL,
  "entity_id" UUID NOT NULL,
  "external_id" TEXT NOT NULL,
  "external_updated_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "crm_native_links_entity_uidx" UNIQUE ("connection_id", "entity_type", "entity_id"),
  CONSTRAINT "crm_native_links_external_uidx" UNIQUE ("connection_id", "entity_type", "external_id")
);
--> statement-breakpoint
CREATE INDEX "crm_native_links_workspace_idx" ON "crm_native_links" ("workspace_id");
--> statement-breakpoint
CREATE TABLE "crm_outbound_writes" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "connection_id" UUID NOT NULL REFERENCES "crm_connections"("id") ON DELETE CASCADE,
  "entity_type" TEXT NOT NULL,
  "entity_id" UUID NOT NULL,
  "patch" JSONB NOT NULL,
  "skout_changed_at" TIMESTAMPTZ NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "lease_owner" TEXT,
  "lease_expires_at" TIMESTAMPTZ,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "crm_outbound_writes_idempotency_uidx" UNIQUE ("idempotency_key")
);
--> statement-breakpoint
CREATE INDEX "crm_outbound_writes_workspace_status_idx" ON "crm_outbound_writes" ("workspace_id", "status");
