ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "type" text NOT NULL DEFAULT 'custom';
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "completed_at" timestamp with time zone;
