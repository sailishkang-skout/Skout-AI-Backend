-- Workbooks V2 (WB2-010) 8/8: inbound webhooks. Only a hash of the token is stored.
CREATE TABLE IF NOT EXISTS "workbook_webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workbook_id" uuid NOT NULL REFERENCES "workbooks"("id") ON DELETE cascade,
	"token_hash" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workbook_webhooks_token_hash_key" UNIQUE ("token_hash")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workbook_webhooks_workbook_idx" ON "workbook_webhooks" ("workbook_id");
