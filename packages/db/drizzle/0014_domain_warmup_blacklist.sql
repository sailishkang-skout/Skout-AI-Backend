-- sending_domains: blacklist monitoring columns
ALTER TABLE "sending_domains"
  ADD COLUMN IF NOT EXISTS "blacklist_status" text NOT NULL DEFAULT 'clean',
  ADD COLUMN IF NOT EXISTS "blacklisted_on"   jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS "last_checked_at"  timestamptz,
  ADD COLUMN IF NOT EXISTS "check_error"      text;

-- inboxes: warmup ramp cursor columns
ALTER TABLE "inboxes"
  ADD COLUMN IF NOT EXISTS "warmup_day"        integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "warmup_started_at" timestamptz;
