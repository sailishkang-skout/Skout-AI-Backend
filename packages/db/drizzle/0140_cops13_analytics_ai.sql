-- COPS-13 (Bible p.83, p.87): account-level AI recommendations extend the next-best-action
-- suggestions (status, type, evidence, confidence, model/prompt pins, human decision), and the
-- warehouse feed keeps one checkpoint per sink.
ALTER TABLE "next_best_action_suggestions" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'pending' NOT NULL;
--> statement-breakpoint
ALTER TABLE "next_best_action_suggestions" ADD COLUMN IF NOT EXISTS "recommendation_type" text;
--> statement-breakpoint
ALTER TABLE "next_best_action_suggestions" ADD COLUMN IF NOT EXISTS "confidence" real;
--> statement-breakpoint
ALTER TABLE "next_best_action_suggestions" ADD COLUMN IF NOT EXISTS "evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "next_best_action_suggestions" ADD COLUMN IF NOT EXISTS "suggested_action" jsonb;
--> statement-breakpoint
ALTER TABLE "next_best_action_suggestions" ADD COLUMN IF NOT EXISTS "source" text;
--> statement-breakpoint
ALTER TABLE "next_best_action_suggestions" ADD COLUMN IF NOT EXISTS "evidence_id" uuid;
--> statement-breakpoint
ALTER TABLE "next_best_action_suggestions" ADD COLUMN IF NOT EXISTS "model_version_id" uuid;
--> statement-breakpoint
ALTER TABLE "next_best_action_suggestions" ADD COLUMN IF NOT EXISTS "prompt_version_id" uuid;
--> statement-breakpoint
ALTER TABLE "next_best_action_suggestions" ADD COLUMN IF NOT EXISTS "input_hash" text;
--> statement-breakpoint
ALTER TABLE "next_best_action_suggestions" ADD COLUMN IF NOT EXISTS "dedupe_key" text;
--> statement-breakpoint
ALTER TABLE "next_best_action_suggestions" ADD COLUMN IF NOT EXISTS "decided_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "next_best_action_suggestions" ADD COLUMN IF NOT EXISTS "decided_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "next_best_action_suggestions" ADD COLUMN IF NOT EXISTS "decision_reason" text;
--> statement-breakpoint
ALTER TABLE "next_best_action_suggestions" ADD COLUMN IF NOT EXISTS "effect" jsonb;
--> statement-breakpoint
ALTER TABLE "next_best_action_suggestions" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
--> statement-breakpoint
-- An NBA suggestion that was already turned into a task or enrollment counts as approved.
UPDATE "next_best_action_suggestions" SET "status" = 'approved', "decided_at" = "accepted_at" WHERE "accepted_at" IS NOT NULL AND "status" = 'pending';
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "next_best_action_suggestions" ADD CONSTRAINT "nba_suggestions_status_check" CHECK ("status" IN ('pending', 'approved', 'dismissed', 'expired'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nba_suggestions_entity_status_idx" ON "next_best_action_suggestions" ("workspace_id", "entity_type", "entity_id", "status");
--> statement-breakpoint
-- One pending recommendation per rule and evidence: regenerating does not duplicate it.
CREATE UNIQUE INDEX IF NOT EXISTS "nba_suggestions_pending_dedupe_uq" ON "next_best_action_suggestions" ("workspace_id", "dedupe_key") WHERE "status" = 'pending' AND "dedupe_key" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cops_analytics_feed_checkpoints" (
  "sink" text PRIMARY KEY NOT NULL,
  "last_created_at" timestamp with time zone,
  "last_event_id" uuid,
  "events_sent" bigint DEFAULT 0 NOT NULL,
  "last_error" text,
  "last_run_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
