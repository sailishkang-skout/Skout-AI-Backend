CREATE TABLE IF NOT EXISTS "sequence_tracking_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"enrollment_step_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"url" text,
	"user_agent" text,
	"ip_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"reason" text DEFAULT 'unsubscribed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppressions_workspace_id_email_unique" UNIQUE("workspace_id","email")
);
--> statement-breakpoint
ALTER TABLE "sequence_enrollment_steps" ADD COLUMN IF NOT EXISTS "failure_reason" text;
--> statement-breakpoint
ALTER TABLE "inboxes" ADD COLUMN IF NOT EXISTS "smtp_host" text;
--> statement-breakpoint
ALTER TABLE "inboxes" ADD COLUMN IF NOT EXISTS "smtp_port" integer;
--> statement-breakpoint
ALTER TABLE "inboxes" ADD COLUMN IF NOT EXISTS "smtp_username" text;
--> statement-breakpoint
ALTER TABLE "inboxes" ADD COLUMN IF NOT EXISTS "smtp_password_encrypted" text;
--> statement-breakpoint
ALTER TABLE "inboxes" ADD COLUMN IF NOT EXISTS "smtp_secure" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "inboxes" ADD COLUMN IF NOT EXISTS "last_used_at" timestamp with time zone;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sequence_tracking_events" ADD CONSTRAINT "sequence_tracking_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sequence_tracking_events" ADD CONSTRAINT "sequence_tracking_events_enrollment_id_sequence_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."sequence_enrollments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sequence_tracking_events" ADD CONSTRAINT "sequence_tracking_events_enrollment_step_id_sequence_enrollment_steps_id_fk" FOREIGN KEY ("enrollment_step_id") REFERENCES "public"."sequence_enrollment_steps"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
