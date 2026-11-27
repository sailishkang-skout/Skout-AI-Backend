-- WB2-026: the inbound webhook of a Workbooks V2 workbook.
-- One per workbook: the webhook table (0177) gains its settings, what its last request did, and the times of recent
-- requests, which is how the limit of 60 a minute holds across every API instance.
ALTER TABLE "workbook_webhooks" ADD COLUMN IF NOT EXISTS "dedupe" jsonb DEFAULT '{"key":"none"}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workbook_webhooks" ADD COLUMN IF NOT EXISTS "token_created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "workbook_webhooks" ADD COLUMN IF NOT EXISTS "recent_requests" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workbook_webhooks" ADD COLUMN IF NOT EXISTS "last_result" jsonb;--> statement-breakpoint
ALTER TABLE "workbook_webhooks" ADD COLUMN IF NOT EXISTS "rate_limit_noted_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workbook_webhooks_workbook_key" ON "workbook_webhooks" ("workbook_id");--> statement-breakpoint
DROP INDEX IF EXISTS "workbook_webhooks_workbook_idx";
