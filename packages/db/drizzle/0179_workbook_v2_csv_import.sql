-- Workbooks V2 CSV import (WB2-020): what a file import needs to run in the background and be retried.
ALTER TABLE "workbook_imports" ADD COLUMN IF NOT EXISTS "created_by" uuid REFERENCES "users"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "workbook_imports" ADD COLUMN IF NOT EXISTS "file_name" text;--> statement-breakpoint
ALTER TABLE "workbook_imports" ADD COLUMN IF NOT EXISTS "file_bytes" integer;--> statement-breakpoint
ALTER TABLE "workbook_imports" ADD COLUMN IF NOT EXISTS "file_key" text;--> statement-breakpoint
ALTER TABLE "workbook_imports" ADD COLUMN IF NOT EXISTS "preview" jsonb;--> statement-breakpoint
ALTER TABLE "workbook_imports" ADD COLUMN IF NOT EXISTS "plan" jsonb;--> statement-breakpoint
ALTER TABLE "workbook_imports" ADD COLUMN IF NOT EXISTS "error" jsonb;--> statement-breakpoint
ALTER TABLE "workbook_imports" ADD COLUMN IF NOT EXISTS "confirmed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workbook_imports_unfinished_idx" ON "workbook_imports" ("status", "updated_at") WHERE "finished_at" IS NULL OR "file_key" IS NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workbook_import_issues" (
	"import_id" uuid NOT NULL REFERENCES "workbook_imports"("id") ON DELETE cascade,
	"record" integer NOT NULL,
	"line" integer NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"values" jsonb NOT NULL,
	CONSTRAINT "workbook_import_issues_pkey" PRIMARY KEY ("import_id", "record")
);
