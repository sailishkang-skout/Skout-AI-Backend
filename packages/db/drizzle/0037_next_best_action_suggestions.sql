-- R20.3 — persist every next-best-action suggestion (accepted or not) so acceptance rate is
-- measurable, not just logged in the chat response.

CREATE TABLE IF NOT EXISTS "next_best_action_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"headline" text NOT NULL,
	"rationale" text,
	"draft_message" text,
	"created_by" uuid,
	"accepted_at" timestamp with time zone,
	"accepted_action" text,
	"accepted_ref_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "next_best_action_suggestions" ADD CONSTRAINT "nba_suggestions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "next_best_action_suggestions" ADD CONSTRAINT "nba_suggestions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nba_suggestions_workspace_id_idx" ON "next_best_action_suggestions" ("workspace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nba_suggestions_workspace_entity_idx" ON "next_best_action_suggestions" ("workspace_id","entity_type","entity_id");
