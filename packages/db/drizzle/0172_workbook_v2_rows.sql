-- Workbooks V2 (WB2-010) 3/8: rows. The id is a bigint identity (WB2-003: ~15% smaller cells and faster than
-- uuid ids). It is guessable, so every query must also filter by workbook_id.
CREATE TABLE IF NOT EXISTS "workbook_rows" (
	"id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY NOT NULL,
	"workbook_id" uuid NOT NULL REFERENCES "workbooks"("id") ON DELETE cascade,
	"position" integer NOT NULL,
	"source" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prospect_id" text,
	"crm_ref" jsonb,
	"suppressed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workbook_rows_workbook_id_id_key" UNIQUE ("workbook_id", "id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workbook_rows_workbook_position_idx" ON "workbook_rows" ("workbook_id", "position");
