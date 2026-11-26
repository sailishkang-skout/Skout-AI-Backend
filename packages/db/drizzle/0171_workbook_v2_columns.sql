-- Workbooks V2 (WB2-010) 2/8: columns. UNIQUE (workbook_id, id) is the target of the composite foreign keys.
CREATE TABLE IF NOT EXISTS "workbook_columns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workbook_id" uuid NOT NULL REFERENCES "workbooks"("id") ON DELETE cascade,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"operation" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" integer NOT NULL,
	"width" integer DEFAULT 160 NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"frozen" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workbook_columns_workbook_id_id_key" UNIQUE ("workbook_id", "id"),
	CONSTRAINT "workbook_columns_type_check" CHECK ("type" IN ('input','enrichment','ai','formula','action'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workbook_columns_workbook_position_idx" ON "workbook_columns" ("workbook_id", "position");
