-- Capture queue becomes a job monitor: each company's capture job has a status the extension
-- keeps in sync, and an error when it failed. Existing rows: finished -> completed, otherwise paused.
ALTER TABLE "enrichment_capture_queue" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'queued' NOT NULL;--> statement-breakpoint
ALTER TABLE "enrichment_capture_queue" ADD COLUMN IF NOT EXISTS "error" text;--> statement-breakpoint
UPDATE "enrichment_capture_queue" SET "status" = CASE WHEN "complete" THEN 'completed' ELSE 'paused' END;--> statement-breakpoint
ALTER TABLE "enrichment_capture_queue" ADD CONSTRAINT "enrichment_capture_queue_status_check" CHECK ("status" IN ('queued','running','review','paused','completed','failed','skipped'));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enrichment_capture_queue_workspace_status_idx" ON "enrichment_capture_queue" ("workspace_id", "status", "updated_at");
