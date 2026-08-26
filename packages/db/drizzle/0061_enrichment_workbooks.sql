-- 8.3 Enrichment workbooks: a reusable, named waterfall configuration (enrichment_workbooks)
-- plus the run-level envelope for executing one (enrichment_workbook_runs). Row-level work
-- reuses the existing enrichment_jobs/enrichment_batches tables via batch_id.

CREATE TABLE IF NOT EXISTS "enrichment_workbooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"name" text NOT NULL,
	"fields" text[] DEFAULT '{"company","email","validation"}' NOT NULL,
	"email_quality_threshold" numeric(3, 2),
	"budget_credits_per_run" integer,
	"status" text DEFAULT 'draft' NOT NULL,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enrichment_workbooks_workspace_id_idx" ON "enrichment_workbooks" ("workspace_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "enrichment_workbook_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workbook_id" uuid NOT NULL REFERENCES "enrichment_workbooks"("id") ON DELETE CASCADE,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"list_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"target_prospect_ids" jsonb DEFAULT '[]' NOT NULL,
	"batch_id" uuid REFERENCES "enrichment_batches"("id") ON DELETE SET NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"processed_rows" integer DEFAULT 0 NOT NULL,
	"succeeded_rows" integer DEFAULT 0 NOT NULL,
	"failed_rows" integer DEFAULT 0 NOT NULL,
	"credits_budget" integer,
	"credits_used" integer DEFAULT 0 NOT NULL,
	"rerun_of_run_id" uuid,
	"error_message" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enrichment_workbook_runs_workbook_id_idx" ON "enrichment_workbook_runs" ("workbook_id", "queued_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enrichment_workbook_runs_workspace_id_idx" ON "enrichment_workbook_runs" ("workspace_id");
