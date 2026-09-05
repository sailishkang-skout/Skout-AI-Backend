-- ADI-13 (§8.3) — workbook activation hand-off: links a workbook to the static list its
-- successfully-enriched rows get materialized into on activation.
ALTER TABLE "enrichment_workbooks" ADD COLUMN IF NOT EXISTS "result_list_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "enrichment_workbooks" ADD CONSTRAINT "enrichment_workbooks_result_list_id_lists_id_fk" FOREIGN KEY ("result_list_id") REFERENCES "public"."lists"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
