-- Capture queue: automatic (server-side, Unipile) people capture next to the extension.
-- mode: who reads the people (extension | unipile). cursor/next_run_at/attempts drive the
-- automatic worker; requested_by is the member whose daily limit and capture runs it uses.
ALTER TABLE "enrichment_capture_queue" ADD COLUMN IF NOT EXISTS "mode" text DEFAULT 'extension' NOT NULL;--> statement-breakpoint
ALTER TABLE "enrichment_capture_queue" ADD COLUMN IF NOT EXISTS "cursor" text;--> statement-breakpoint
ALTER TABLE "enrichment_capture_queue" ADD COLUMN IF NOT EXISTS "next_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "enrichment_capture_queue" ADD COLUMN IF NOT EXISTS "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "enrichment_capture_queue" ADD COLUMN IF NOT EXISTS "linkedin_company_id" text;--> statement-breakpoint
ALTER TABLE "enrichment_capture_queue" ADD COLUMN IF NOT EXISTS "requested_by" uuid REFERENCES "users"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "enrichment_capture_queue" ADD CONSTRAINT "enrichment_capture_queue_mode_check" CHECK ("mode" IN ('extension','unipile'));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enrichment_capture_queue_auto_due_idx" ON "enrichment_capture_queue" ("mode", "status", "next_run_at");
