CREATE TABLE "workbook_column_definitions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "workbook_id" UUID NOT NULL REFERENCES "enrichment_workbooks"("id") ON DELETE CASCADE,
  "key" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "column_type" TEXT NOT NULL,
  "config" JSONB NOT NULL,
  "order_index" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "workbook_column_definitions_workbook_id_key_unique" UNIQUE ("workbook_id", "key")
);
--> statement-breakpoint
CREATE TABLE "workbook_column_values" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "workbook_run_id" UUID NOT NULL REFERENCES "enrichment_workbook_runs"("id") ON DELETE CASCADE,
  "column_definition_id" UUID NOT NULL REFERENCES "workbook_column_definitions"("id") ON DELETE CASCADE,
  "prospect_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "value" TEXT,
  "evidence_id" UUID,
  "error" TEXT,
  "computed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "workbook_column_values_run_col_prospect_uidx" UNIQUE ("workbook_run_id", "column_definition_id", "prospect_id")
);
--> statement-breakpoint
CREATE INDEX "workbook_column_definitions_workbook_idx" ON "workbook_column_definitions" ("workbook_id", "order_index");
--> statement-breakpoint
CREATE INDEX "workbook_column_values_run_idx" ON "workbook_column_values" ("workbook_run_id");
