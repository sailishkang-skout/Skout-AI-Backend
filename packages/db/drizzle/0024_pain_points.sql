ALTER TABLE "prospect_scores" ADD COLUMN IF NOT EXISTS "pain_points" text[] NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE "prospect_scores" ADD COLUMN IF NOT EXISTS "pain_points_rationale" text;

