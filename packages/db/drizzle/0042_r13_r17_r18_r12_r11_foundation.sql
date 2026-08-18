-- R11.1 tech-stack signal snapshots, R13.2 draft auto-approve, R17.3 alert rules + digest
-- delivery, R18.1 SDR ownership for alert routing, R12.1/R12.2 TAM.

-- R11.1 — snapshot the tech stack alongside headcount so a re-crawl can diff it.
ALTER TABLE "company_snapshots" ADD COLUMN IF NOT EXISTS "tech_stack" jsonb;
--> statement-breakpoint

-- R17.3 — resumable watermark for the alert-sweep worker.
ALTER TABLE "signals" ADD COLUMN IF NOT EXISTS "alerted_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signals_unalerted_idx" ON "signals" ("alerted_at","created_at");
--> statement-breakpoint

-- R13.2 — audit tag distinguishing an auto-approved draft from a human-approved one.
ALTER TABLE "ai_drafts" ADD COLUMN IF NOT EXISTS "auto_approved" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- R17.3 — digest delivery bookkeeping.
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "digested_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN IF NOT EXISTS "digest" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- R17.3 — the SDR an account/prospect is routed to for signal alerts.
ALTER TABLE "prospect_activations" ADD COLUMN IF NOT EXISTS "owner_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "prospect_activations" ADD CONSTRAINT "prospect_activations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- R13.2 — one row per workspace: auto-approve thresholds + always-review escape hatch.
CREATE TABLE IF NOT EXISTS "draft_auto_approve_settings" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean NOT NULL DEFAULT false,
	"min_icp_score" integer,
	"min_confidence" real,
	"always_review_list_ids" jsonb NOT NULL DEFAULT '[]',
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "draft_auto_approve_settings" ADD CONSTRAINT "draft_auto_approve_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "draft_auto_approve_settings" ADD CONSTRAINT "draft_auto_approve_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- R17.3 — "signal type (+ min confidence) on a workspace-owned account -> notify the owning SDR."
CREATE TABLE IF NOT EXISTS "alert_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"signal_type" text NOT NULL,
	"min_confidence" real,
	"enabled" boolean NOT NULL DEFAULT true,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alert_rules_workspace_id_idx" ON "alert_rules" ("workspace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alert_rules_workspace_signal_type_idx" ON "alert_rules" ("workspace_id","signal_type","enabled");
--> statement-breakpoint

-- R12.1/R12.2 — saved, re-computable TAM (segment breakdown + coverage funnel).
CREATE TABLE IF NOT EXISTS "tams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"filter_config" jsonb,
	"total_count" integer NOT NULL DEFAULT 0,
	"segment_breakdown" jsonb NOT NULL DEFAULT '[]',
	"coverage" jsonb NOT NULL DEFAULT '{}',
	"last_computed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tams" ADD CONSTRAINT "tams_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tams" ADD CONSTRAINT "tams_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
