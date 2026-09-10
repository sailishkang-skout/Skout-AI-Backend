-- R2.1: Inbound email ingestion + thread model
-- Adds RFC 5322 header columns to inbox_messages for thread matching,
-- enrollmentId link on inbox_threads, and IMAP polling fields on inboxes.

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
