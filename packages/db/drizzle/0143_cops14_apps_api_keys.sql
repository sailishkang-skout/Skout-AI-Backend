-- COPS-14 (integration framework): connected apps and their scoped API keys.
CREATE TABLE IF NOT EXISTS "cops_apps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text,
  "homepage_url" text,
  "status" text DEFAULT 'active' NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cops_apps_status_check" CHECK ("status" IN ('active', 'disabled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cops_apps_workspace_name_uq" ON "cops_apps" ("workspace_id", lower("name"));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cops_api_credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "app_id" uuid NOT NULL REFERENCES "cops_apps"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "prefix" text NOT NULL,
  "key_hash" text NOT NULL,
  "scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "expires_at" timestamp with time zone,
  "last_used_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "revoke_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cops_api_credentials_prefix_uq" ON "cops_api_credentials" ("prefix");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cops_api_credentials_app_idx" ON "cops_api_credentials" ("app_id");
