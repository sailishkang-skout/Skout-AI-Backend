-- Workbooks V2 (WB2-010) 6/8: imports.
CREATE TABLE IF NOT EXISTS "workbook_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workbook_id" uuid NOT NULL REFERENCES "workbooks"("id") ON DELETE cascade,
	"source_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_report_file" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workbook_imports_workbook_created_idx" ON "workbook_imports" ("workbook_id", "created_at");
