-- Workbooks V2 (WB2-010, PRD section 9) 1/8: the workbook itself.
-- The legacy enrichment_workbooks* and workbook_column_* tables are not touched; archived_source_id is
-- deliberately not a foreign key to them (an FK would add triggers there and block their later removal).
CREATE TABLE IF NOT EXISTS "workbooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
	"name" text NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"row_limit" integer DEFAULT 100000 NOT NULL,
	"created_by" uuid REFERENCES "users"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"archived_source_id" uuid
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workbooks_workspace_idx" ON "workbooks" ("workspace_id") WHERE "deleted_at" IS NULL;
