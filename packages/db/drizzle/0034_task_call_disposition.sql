-- R20.4 — call disposition on the CRM task created by the sequence "call" step, plus enough
-- context (prospectId + enrollment/step ids) for that disposition to branch/advance the
-- sequence the same way reply/bounce detection already does.

ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "disposition" text;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "prospect_id" text;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "sequence_enrollment_id" uuid;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "sequence_enrollment_step_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tasks" ADD CONSTRAINT "tasks_sequence_enrollment_id_sequence_enrollments_id_fk" FOREIGN KEY ("sequence_enrollment_id") REFERENCES "public"."sequence_enrollments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tasks" ADD CONSTRAINT "tasks_sequence_enrollment_step_id_sequence_enrollment_steps_id_fk" FOREIGN KEY ("sequence_enrollment_step_id") REFERENCES "public"."sequence_enrollment_steps"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_sequence_enrollment_step_id_idx" ON "tasks" ("sequence_enrollment_step_id");
