-- SS-08 — real-time signal → activation-rule trigger (signal-activation-sweep.worker.ts).
-- Independent of `alerted_at` (R17.3): that column tracks the human-notification sweep,
-- this one tracks the separate automated-next-step sweep, so each consumer is idempotent
-- on its own column without the two stepping on each other.
ALTER TABLE "signals" ADD COLUMN IF NOT EXISTS "activation_checked_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signals_unactivation_checked_idx" ON "signals" ("activation_checked_at","created_at");
