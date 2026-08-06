-- R10.2: auto-refresh cadence for smart lists
ALTER TABLE "smart_lists"
  ADD COLUMN IF NOT EXISTS "refresh_cadence" text NOT NULL DEFAULT 'off',
  ADD COLUMN IF NOT EXISTS "next_refresh_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "last_refreshed_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "smart_list_members" (
  "smart_list_id" uuid NOT NULL REFERENCES "smart_lists"("id") ON DELETE cascade,
  "prospect_id" text NOT NULL,
  "snapshot" jsonb NOT NULL DEFAULT '{}',
  "added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "smart_list_members_smart_list_id_idx" ON "smart_list_members" ("smart_list_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "smart_list_refreshes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "smart_list_id" uuid NOT NULL REFERENCES "smart_lists"("id") ON DELETE cascade,
  "status" text NOT NULL,
  "matched_count" integer NOT NULL DEFAULT 0,
  "added_count" integer NOT NULL DEFAULT 0,
  "dropped_count" integer NOT NULL DEFAULT 0,
  "added_prospects" jsonb NOT NULL DEFAULT '[]',
  "dropped_prospects" jsonb NOT NULL DEFAULT '[]',
  "credits_charged" integer NOT NULL DEFAULT 0,
  "required_credits" integer,
  "available_credits" integer,
  "error_message" text,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "smart_list_refreshes_smart_list_id_idx" ON "smart_list_refreshes" ("smart_list_id", "created_at");
