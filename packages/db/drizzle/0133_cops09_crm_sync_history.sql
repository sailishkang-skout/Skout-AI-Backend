-- COPS-09: per-record inbound sync history (what each pulled HubSpot record did to Skout).
-- Idempotent: safe to run twice.

CREATE TABLE IF NOT EXISTS "crm_sync_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "connection_id" uuid NOT NULL REFERENCES "crm_connections"("id") ON DELETE CASCADE,
  "entity_type" text NOT NULL,
  "entity_id" uuid,
  "external_id" text NOT NULL,
  "outcome" text NOT NULL,
  "fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "held_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "detail" text,
  "external_modified_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "crm_sync_history_entity_idx" ON "crm_sync_history" ("workspace_id", "entity_type", "entity_id", "created_at");
CREATE INDEX IF NOT EXISTS "crm_sync_history_workspace_idx" ON "crm_sync_history" ("workspace_id", "created_at");
