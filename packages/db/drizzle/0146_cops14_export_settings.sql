-- COPS-14 configurable warehouse export per workspace. No row means on, every event type.
CREATE TABLE IF NOT EXISTS "cops_export_settings" (
  "workspace_id" uuid PRIMARY KEY NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "enabled" boolean DEFAULT true NOT NULL,
  "event_types" jsonb,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "reason" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
