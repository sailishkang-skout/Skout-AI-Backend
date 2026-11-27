-- WB2-025: Google Sheets as a Workbooks V2 row source.
-- Each member connects their own Google account within a workspace. Tokens are stored encrypted; `state_hash` holds a
-- one-time sign-in state while a connection is being made.
CREATE TABLE IF NOT EXISTS "google_sheets_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"status" text DEFAULT 'pending' NOT NULL,
	"access_token_encrypted" text,
	"refresh_token_encrypted" text,
	"token_expires_at" timestamp with time zone,
	"state_hash" text,
	"state_expires_at" timestamp with time zone,
	"connected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "google_sheets_connections_member_key" UNIQUE ("workspace_id", "user_id"),
	CONSTRAINT "google_sheets_connections_status_check" CHECK ("status" IN ('pending','connected','needs_reauth'))
);--> statement-breakpoint
-- One tab of one spreadsheet a workbook takes rows from, with how its headers map and how its rows are recognised.
CREATE TABLE IF NOT EXISTS "workbook_sheet_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workbook_id" uuid NOT NULL REFERENCES "workbooks"("id") ON DELETE cascade,
	"spreadsheet_id" text NOT NULL,
	"sheet_id" bigint NOT NULL,
	"spreadsheet_name" text NOT NULL,
	"tab_name" text NOT NULL,
	"mapping" jsonb NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid REFERENCES "users"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_pulled_at" timestamp with time zone,
	CONSTRAINT "workbook_sheet_sources_tab_key" UNIQUE ("workbook_id", "spreadsheet_id", "sheet_id")
);--> statement-breakpoint
-- Every sheet row a source has already added, by identity, so it is never added again, even after the workbook row it
-- became is edited or deleted.
CREATE TABLE IF NOT EXISTS "workbook_sheet_keys" (
	"source_id" uuid NOT NULL REFERENCES "workbook_sheet_sources"("id") ON DELETE cascade,
	"key" text NOT NULL,
	CONSTRAINT "workbook_sheet_keys_pkey" PRIMARY KEY ("source_id", "key")
);--> statement-breakpoint
ALTER TABLE "workbook_imports" ADD COLUMN IF NOT EXISTS "sheet_source_id" uuid REFERENCES "workbook_sheet_sources"("id") ON DELETE set null;--> statement-breakpoint
-- A tab is read by one import at a time, however many times "Pull new rows" is asked for.
CREATE UNIQUE INDEX IF NOT EXISTS "workbook_imports_sheet_running_key" ON "workbook_imports" ("sheet_source_id") WHERE "sheet_source_id" IS NOT NULL AND "status" IN ('queued','processing');
