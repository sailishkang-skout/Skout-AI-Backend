-- Google Calendar integration: per-user OAuth connection + Meet link/invitees on meetings.
-- meetingUrl stays the source of truth for the meeting-bot join link (R16.2) — a Meet link
-- created here lands in that same column, so schedule-bot needs no changes.
CREATE TABLE IF NOT EXISTS "calendar_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"connected_email" text NOT NULL,
	"oauth_access_token_encrypted" text NOT NULL,
	"oauth_refresh_token_encrypted" text,
	"oauth_token_expires_at" timestamp with time zone,
	"oauth_scope" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_connections_workspace_id_user_id_unique" UNIQUE("workspace_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN IF NOT EXISTS "invitees" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN IF NOT EXISTS "google_event_id" text;
--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN IF NOT EXISTS "google_calendar_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meetings_google_event_id_idx" ON "meetings" ("google_event_id");
