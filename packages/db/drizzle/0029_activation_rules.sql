-- R13.4 — Auto-activation rules: "score >= X (+ optional signal) -> action" rule engine.
-- Capped at 5 active rules per workspace at the application layer (see
-- ActivationRulesService.create) as a guardrail against runaway automation, per
-- docs/tickets/phase-1-feature-work-plan.md R13.4 acceptance criteria.

CREATE TABLE IF NOT EXISTS "activation_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"score_threshold" integer NOT NULL,
	"signal_type" text,
	"target_action" text NOT NULL,
	"target_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activation_rules" ADD CONSTRAINT "activation_rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activation_rules" ADD CONSTRAINT "activation_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activation_rules_workspace_id_idx" ON "activation_rules" ("workspace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activation_rules_workspace_enabled_idx" ON "activation_rules" ("workspace_id","enabled");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "activation_rule_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"prospect_id" text NOT NULL,
	"action_taken" text NOT NULL,
	"reversed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activation_rule_runs" ADD CONSTRAINT "activation_rule_runs_rule_id_activation_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."activation_rules"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activation_rule_runs_workspace_id_idx" ON "activation_rule_runs" ("workspace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activation_rule_runs_rule_id_idx" ON "activation_rule_runs" ("rule_id");
