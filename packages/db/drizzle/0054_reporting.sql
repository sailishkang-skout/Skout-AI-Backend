-- 8.15 Reporting: scheduled report delivery with a snapshot/version history, plus the
-- forecasting split (model-generated / manager-adjusted / rep-committed).

CREATE TABLE IF NOT EXISTS "report_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"name" text NOT NULL,
	"cadence" text DEFAULT 'weekly' NOT NULL,
	"recipient_emails" text[] DEFAULT '{}' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_sent_at" timestamp with time zone,
	"next_send_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_schedules_workspace_idx" ON "report_schedules" ("workspace_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "report_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid REFERENCES "report_schedules"("id") ON DELETE CASCADE,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"version" integer DEFAULT 1 NOT NULL,
	"rollup" jsonb NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_snapshots_schedule_idx" ON "report_snapshots" ("schedule_id", "version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_snapshots_workspace_idx" ON "report_snapshots" ("workspace_id", "generated_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "revenue_forecasts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"period_label" text NOT NULL,
	"model_amount" numeric(14, 2) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"manager_adjusted_amount" numeric(14, 2),
	"manager_adjusted_reason" text,
	"manager_adjusted_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"rep_committed_amount" numeric(14, 2),
	"rep_committed_reason" text,
	"rep_committed_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "revenue_forecasts_workspace_id_period_label_unique" UNIQUE("workspace_id","period_label")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "revenue_forecasts_workspace_idx" ON "revenue_forecasts" ("workspace_id");
