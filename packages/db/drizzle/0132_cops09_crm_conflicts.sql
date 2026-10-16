-- COPS-09: CRM sync conflict queue. A field whose policy is manual review, or whose Skout and
-- provider values were edited concurrently, is held here until an admin resolves it.
-- Idempotent: safe to run twice.

CREATE TABLE IF NOT EXISTS "crm_conflicts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "connection_id" uuid NOT NULL REFERENCES "crm_connections"("id") ON DELETE CASCADE,
  "entity_type" text NOT NULL,
  "entity_id" uuid NOT NULL,
  "external_id" text NOT NULL,
  "field_name" text NOT NULL,
  "skout_value" text,
  "external_value" text,
  "skout_updated_at" timestamptz,
  "external_updated_at" timestamptz,
  "policy" text DEFAULT 'manual_review' NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "resolved_value" text,
  "resolved_at" timestamptz,
  "resolved_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "crm_conflicts_workspace_status_idx" ON "crm_conflicts" ("workspace_id", "status");
CREATE INDEX IF NOT EXISTS "crm_conflicts_entity_idx" ON "crm_conflicts" ("connection_id", "entity_type", "entity_id");
-- One open conflict per field: a repeated poll or webhook updates it instead of queueing another.
CREATE UNIQUE INDEX IF NOT EXISTS "crm_conflicts_one_pending_uq" ON "crm_conflicts" ("connection_id", "entity_type", "entity_id", "field_name") WHERE status = 'pending';
