-- R16.2 — Meeting bot join + notes. R16.3 (auto-fill from transcript) reads these columns.
ALTER TABLE "meetings" ADD COLUMN IF NOT EXISTS "meeting_url" text;
--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN IF NOT EXISTS "bot_external_id" text;
--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN IF NOT EXISTS "bot_status" text DEFAULT 'not_scheduled' NOT NULL;
--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN IF NOT EXISTS "recording_url" text;
--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN IF NOT EXISTS "transcript_url" text;
--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN IF NOT EXISTS "transcript" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meetings_bot_external_id_idx" ON "meetings" ("bot_external_id");
