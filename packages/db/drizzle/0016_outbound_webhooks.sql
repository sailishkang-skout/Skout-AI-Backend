-- webhook_endpoints: add columns for full outbound webhook support
ALTER TABLE "webhook_endpoints"
  ADD COLUMN IF NOT EXISTS "description"   text,
  ADD COLUMN IF NOT EXISTS "enabled"       boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "event_types"   jsonb NOT NULL DEFAULT '[]';

-- Drop the old text[] events column — event_types (jsonb) replaces it
ALTER TABLE "webhook_endpoints"
  DROP COLUMN IF EXISTS "events",
  DROP COLUMN IF EXISTS "status";

CREATE INDEX IF NOT EXISTS "webhook_endpoints_workspace_id_idx"
  ON "webhook_endpoints" ("workspace_id");

-- webhook_deliveries: replace stub with full delivery log schema
ALTER TABLE "webhook_deliveries"
  ADD COLUMN IF NOT EXISTS "workspace_id"  uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  ADD COLUMN IF NOT EXISTS "event_id"      text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "attempt"       integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "status_code"   integer,
  ADD COLUMN IF NOT EXISTS "response_body" text,
  ADD COLUMN IF NOT EXISTS "duration_ms"   integer,
  ADD COLUMN IF NOT EXISTS "error_message" text,
  ADD COLUMN IF NOT EXISTS "delivered_at"  timestamptz;

-- Drop the old stub columns
ALTER TABLE "webhook_deliveries"
  DROP COLUMN IF EXISTS "attempts",
  DROP COLUMN IF EXISTS "response_status",
  DROP COLUMN IF EXISTS "last_attempt_at";

CREATE INDEX IF NOT EXISTS "webhook_deliveries_endpoint_id_idx"
  ON "webhook_deliveries" ("endpoint_id");

CREATE INDEX IF NOT EXISTS "webhook_deliveries_workspace_event_idx"
  ON "webhook_deliveries" ("workspace_id", "event_type");
