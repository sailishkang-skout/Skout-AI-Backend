-- Capture queue: which step of the company workflow a job is on (company -> jobs -> people -> verify)
-- and what each step produced. Additive and nullable: existing jobs keep working as people-only jobs.
ALTER TABLE "enrichment_capture_queue" ADD COLUMN IF NOT EXISTS "step" text;
ALTER TABLE "enrichment_capture_queue" ADD COLUMN IF NOT EXISTS "step_detail" jsonb;
