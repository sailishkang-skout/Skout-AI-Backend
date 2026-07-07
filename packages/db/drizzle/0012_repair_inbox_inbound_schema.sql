-- Repair migration: ensure R2.1/R2.2 inbox columns exist even if 0010/0011
-- were recorded without applying (duplicate migration file confusion).

ALTER TABLE "inboxes" ADD COLUMN IF NOT EXISTS "imap_host" text;
--> statement-breakpoint
ALTER TABLE "inboxes" ADD COLUMN IF NOT EXISTS "imap_port" integer;
--> statement-breakpoint
ALTER TABLE "inboxes" ADD COLUMN IF NOT EXISTS "imap_last_polled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "inbox_threads" ADD COLUMN IF NOT EXISTS "enrollment_id" uuid;
--> statement-breakpoint
ALTER TABLE "inbox_messages" ADD COLUMN IF NOT EXISTS "message_id" text;
--> statement-breakpoint
ALTER TABLE "inbox_messages" ADD COLUMN IF NOT EXISTS "in_reply_to" text;
--> statement-breakpoint
ALTER TABLE "inbox_messages" ADD COLUMN IF NOT EXISTS "references_header" text;
--> statement-breakpoint
ALTER TABLE "inbox_messages" ADD COLUMN IF NOT EXISTS "classification" text;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inbox_threads" ADD CONSTRAINT "inbox_threads_enrollment_id_sequence_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."sequence_enrollments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "inbox_threads" ADD COLUMN IF NOT EXISTS "status_changed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "inbox_threads" ADD COLUMN IF NOT EXISTS "unread_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "inbox_threads" ADD COLUMN IF NOT EXISTS "reply_tag" text;
--> statement-breakpoint
UPDATE "inbox_threads" SET "status" = 'new' WHERE "status" = 'open';
