ALTER TABLE "sequence_enrollment_steps" ADD COLUMN IF NOT EXISTS "inbox_id" uuid;--> statement-breakpoint
ALTER TABLE "inboxes" ADD COLUMN IF NOT EXISTS "sent_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inboxes" ADD COLUMN IF NOT EXISTS "bounce_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inboxes" ADD COLUMN IF NOT EXISTS "spam_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sequence_enrollment_steps" ADD CONSTRAINT "sequence_enrollment_steps_inbox_id_inboxes_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "public"."inboxes"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
