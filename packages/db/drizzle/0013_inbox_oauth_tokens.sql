ALTER TABLE "inboxes"
  ADD COLUMN IF NOT EXISTS "oauth_access_token_encrypted" text,
  ADD COLUMN IF NOT EXISTS "oauth_refresh_token_encrypted" text,
  ADD COLUMN IF NOT EXISTS "oauth_token_expires_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "oauth_scope" text;
