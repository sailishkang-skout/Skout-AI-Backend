-- Phase 0 CRM bridge foundation: promotion_candidates table + workspaces.deal_promotion_threshold.
-- One row per prospect that has ever crossed a workspace's threshold; re-scoring an already-
-- pending candidate updates score in place (see the unique constraint) rather than duplicating.
CREATE TABLE IF NOT EXISTS "promotion_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"prospect_id" text NOT NULL,
	"score" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promotion_candidates_workspace_id_prospect_id_unique" UNIQUE("workspace_id","prospect_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promotion_candidates_workspace_status_idx" ON "promotion_candidates" ("workspace_id","status");
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "deal_promotion_threshold" integer DEFAULT 80 NOT NULL;
