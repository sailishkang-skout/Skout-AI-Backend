-- §8.15 SP-10 — GTM learning cross-tab: one row per executed sequence-enrollment step,
-- joining ICP x signal x message x channel x outcome. See packages/db/src/schema/reporting.ts
-- for the full column-by-column rationale.
CREATE TABLE IF NOT EXISTS "gtm_learning_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"enrollment_step_id" uuid NOT NULL,
	"sequence_id" uuid NOT NULL,
	"prospect_id" text NOT NULL,
	"touchpoint_at" timestamp with time zone NOT NULL,
	"channel" text NOT NULL,
	"sequence_version_id" uuid,
	"variant_key" text,
	"icp_score" integer,
	"icp_priority" text,
	"signal_type" text,
	"signal_strength" real,
	"replied" boolean DEFAULT false NOT NULL,
	"meeting_booked" boolean DEFAULT false NOT NULL,
	"opportunity_created" boolean DEFAULT false NOT NULL,
	"pipeline_amount" numeric(14, 2),
	"revenue_amount" numeric(14, 2),
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gtm_learning_outcomes_step_unique" UNIQUE("workspace_id","enrollment_step_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gtm_learning_outcomes" ADD CONSTRAINT "gtm_learning_outcomes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gtm_learning_outcomes" ADD CONSTRAINT "gtm_learning_outcomes_enrollment_id_sequence_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."sequence_enrollments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gtm_learning_outcomes" ADD CONSTRAINT "gtm_learning_outcomes_enrollment_step_id_sequence_enrollment_steps_id_fk" FOREIGN KEY ("enrollment_step_id") REFERENCES "public"."sequence_enrollment_steps"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gtm_learning_outcomes" ADD CONSTRAINT "gtm_learning_outcomes_sequence_id_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."sequences"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gtm_learning_outcomes_workspace_channel_idx" ON "gtm_learning_outcomes" ("workspace_id","channel");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gtm_learning_outcomes_workspace_signal_idx" ON "gtm_learning_outcomes" ("workspace_id","signal_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gtm_learning_outcomes_workspace_variant_idx" ON "gtm_learning_outcomes" ("workspace_id","variant_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gtm_learning_outcomes_workspace_sequence_idx" ON "gtm_learning_outcomes" ("workspace_id","sequence_id");
