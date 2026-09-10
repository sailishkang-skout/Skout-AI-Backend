-- Idempotent repair for R3.1 OAuth + domain warmup/blacklist columns.
-- Safe to run when 0013/0014 were skipped or only partially applied on dev RDS.

ALTER TABLE "inboxes"
  ADD COLUMN IF NOT EXISTS "oauth_access_token_encrypted" text,
  ADD COLUMN IF NOT EXISTS "oauth_refresh_token_encrypted" text,
  ADD COLUMN IF NOT EXISTS "oauth_token_expires_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "oauth_scope" text,
  ADD COLUMN IF NOT EXISTS "warmup_day" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "warmup_started_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "sending_domains"
  ADD COLUMN IF NOT EXISTS "blacklist_status" text NOT NULL DEFAULT 'clean',
  ADD COLUMN IF NOT EXISTS "blacklisted_on" jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS "last_checked_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "check_error" text;
