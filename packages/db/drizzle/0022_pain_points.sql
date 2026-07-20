ALTER TABLE "prospect_scores" ADD COLUMN "pain_points" text[] NOT NULL DEFAULT '{}';
ALTER TABLE "prospect_scores" ADD COLUMN "pain_points_rationale" text;
