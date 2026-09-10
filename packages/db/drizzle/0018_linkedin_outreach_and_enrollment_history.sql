-- Allow multiple historical enrollments per prospect/sequence; only one active at a time.
ALTER TABLE "sequence_enrollments" DROP CONSTRAINT IF EXISTS "sequence_enrollments_sequence_id_prospect_id_unique";
DROP INDEX IF EXISTS "sequence_enrollments_sequence_id_prospect_id_unique";

CREATE UNIQUE INDEX IF NOT EXISTS "sequence_enrollments_active_unique"
  ON "sequence_enrollments" ("sequence_id", "prospect_id")
  WHERE "status" = 'active';

-- LinkedIn step action: connect | message
ALTER TABLE "sequence_steps"
  ADD COLUMN IF NOT EXISTS "linkedin_action" text;

CREATE TABLE IF NOT EXISTS "linkedin_outreach_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "enrollment_id" uuid NOT NULL REFERENCES "sequence_enrollments"("id") ON DELETE cascade,
  "enrollment_step_id" uuid NOT NULL REFERENCES "sequence_enrollment_steps"("id") ON DELETE cascade,
  "prospect_id" text NOT NULL,
  "linkedin_url" text NOT NULL,
  "action" text NOT NULL,
  "message" text,
  "status" text NOT NULL DEFAULT 'pending',
  "failure_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "linkedin_outreach_jobs_enrollment_step_id_unique" UNIQUE ("enrollment_step_id")
);

CREATE INDEX IF NOT EXISTS "linkedin_outreach_jobs_pending_idx"
  ON "linkedin_outreach_jobs" ("workspace_id", "status", "created_at")
  WHERE "status" = 'pending';
