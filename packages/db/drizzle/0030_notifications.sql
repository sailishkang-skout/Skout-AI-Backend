-- R17.1: in-app notification center
CREATE TABLE IF NOT EXISTS "notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "user_id" uuid REFERENCES "users"("id") ON DELETE cascade,
  "type" text NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" text NOT NULL,
  "title" text NOT NULL,
  "body" text,
  "read_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_workspace_user_read_idx" ON "notifications" ("workspace_id", "user_id", "read_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_workspace_type_idx" ON "notifications" ("workspace_id", "type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_entity_idx" ON "notifications" ("entity_type", "entity_id");
