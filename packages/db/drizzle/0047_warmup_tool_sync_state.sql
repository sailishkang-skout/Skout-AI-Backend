CREATE TABLE IF NOT EXISTS "warmup_tool_sync_state" (
  "workspace_id" uuid PRIMARY KEY REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "last_event_id" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
