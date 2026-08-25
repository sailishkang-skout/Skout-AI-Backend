-- Completes the Signal entity per the vision doc's field list (source/observed-time/
-- detection-time/strength/expiry/affected-entity/evidence/activation-paths): adds the
-- expiry and permitted-activation-paths fields that were missing from the original
-- signals table (0028_signals.sql).

ALTER TABLE "signals" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN IF NOT EXISTS "activation_paths" jsonb DEFAULT '[]' NOT NULL;
