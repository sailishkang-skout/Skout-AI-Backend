-- LVH-01 — link a LinkedIn voice handoff back to the sequence enrollment step that created it,
-- so a "voice" sequence step can park until the handoff is confirmed (or expires) instead of
-- only existing as a disconnected, ad-hoc one-prospect-at-a-time wizard.
ALTER TABLE "linkedin_voice_handoffs" ADD COLUMN IF NOT EXISTS "enrollment_id" uuid;
--> statement-breakpoint
ALTER TABLE "linkedin_voice_handoffs" ADD COLUMN IF NOT EXISTS "enrollment_step_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "linkedin_voice_handoffs" ADD CONSTRAINT "linkedin_voice_handoffs_enrollment_id_sequence_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."sequence_enrollments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "linkedin_voice_handoffs" ADD CONSTRAINT "linkedin_voice_handoffs_enrollment_step_id_sequence_enrollment_steps_id_fk" FOREIGN KEY ("enrollment_step_id") REFERENCES "public"."sequence_enrollment_steps"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "linkedin_voice_handoffs_enrollment_step_uidx" ON "linkedin_voice_handoffs" ("enrollment_step_id") WHERE "enrollment_step_id" IS NOT NULL;
