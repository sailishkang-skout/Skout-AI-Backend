-- Capture queue dashboard: jobs can be cancelled, and each job keeps how many people its saved
-- batches added (created), matched people already in the workspace (merged / duplicates) or
-- refused (rejected).
ALTER TABLE "enrichment_capture_queue" DROP CONSTRAINT IF EXISTS "enrichment_capture_queue_status_check";--> statement-breakpoint
ALTER TABLE "enrichment_capture_queue" ADD CONSTRAINT "enrichment_capture_queue_status_check" CHECK ("status" IN ('queued','running','review','paused','completed','failed','skipped','cancelled'));--> statement-breakpoint
ALTER TABLE "enrichment_capture_queue" ADD COLUMN IF NOT EXISTS "people_created" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "enrichment_capture_queue" ADD COLUMN IF NOT EXISTS "people_merged" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "enrichment_capture_queue" ADD COLUMN IF NOT EXISTS "people_rejected" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enrichment_capture_queue_workspace_created_idx" ON "enrichment_capture_queue" ("workspace_id", "created_at");
