-- R2.2: Conversation state machine
-- Adds status_changed_at, unread_count, reply_tag to inbox_threads;
-- renames default thread status from 'open' to 'new'.

ALTER TABLE "inbox_threads" ADD COLUMN IF NOT EXISTS "status_changed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "inbox_threads" ADD COLUMN IF NOT EXISTS "unread_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "inbox_threads" ADD COLUMN IF NOT EXISTS "reply_tag" text;
--> statement-breakpoint
-- Migrate existing 'open' threads (R2.1 legacy) to the new canonical 'new' status
UPDATE "inbox_threads" SET "status" = 'new' WHERE "status" = 'open';
