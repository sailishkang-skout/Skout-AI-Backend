ALTER TABLE "inboxes"
  ADD COLUMN "oauth_access_token_encrypted" text,
  ADD COLUMN "oauth_refresh_token_encrypted" text,
  ADD COLUMN "oauth_token_expires_at" timestamp with time zone,
  ADD COLUMN "oauth_scope" text;
