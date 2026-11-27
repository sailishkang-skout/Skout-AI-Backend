-- Workbooks V2 rows from Skout lists, smart lists and search (WB2-021).
ALTER TABLE "workbook_cells" ADD COLUMN IF NOT EXISTS "verification" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workbook_rows_workbook_prospect_key" ON "workbook_rows" ("workbook_id", "prospect_id") WHERE "prospect_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workbook_import_items" (
	"import_id" uuid NOT NULL REFERENCES "workbook_imports"("id") ON DELETE cascade,
	"seq" integer NOT NULL,
	"prospect_id" text NOT NULL,
	CONSTRAINT "workbook_import_items_pkey" PRIMARY KEY ("import_id", "seq")
);--> statement-breakpoint
-- Stored enrichment is read for many prospects at once.
CREATE INDEX IF NOT EXISTS "enrichment_results_workspace_prospect_idx" ON "enrichment_results" ("workspace_id", "prospect_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contacts_workspace_source_prospect_idx" ON "contacts" ("workspace_id", "source_prospect_id");
