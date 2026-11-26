-- Workbooks V2 (WB2-010) 5/8: runs of one column. The composite foreign key keeps a run on its own workbook's column.
CREATE TABLE IF NOT EXISTS "workbook_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workbook_id" uuid NOT NULL REFERENCES "workbooks"("id") ON DELETE cascade,
	"column_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"row_filter" jsonb,
	"status" text DEFAULT 'queued' NOT NULL,
	"max_credits" integer DEFAULT 0 NOT NULL,
	"credits_used" integer DEFAULT 0 NOT NULL,
	"ai_actions_used" integer DEFAULT 0 NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_by" uuid REFERENCES "users"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "workbook_runs_column_fk" FOREIGN KEY ("workbook_id", "column_id") REFERENCES "workbook_columns"("workbook_id", "id") ON DELETE cascade,
	CONSTRAINT "workbook_runs_scope_check" CHECK ("scope" IN ('all','empty','failed','selected','first10'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workbook_runs_workbook_created_idx" ON "workbook_runs" ("workbook_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workbook_runs_workbook_column_idx" ON "workbook_runs" ("workbook_id", "column_id");
