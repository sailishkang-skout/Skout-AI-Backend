-- channel: linkedin | whatsapp (Unipile multi-provider accounts)
ALTER TABLE "linkedin_accounts" ADD COLUMN IF NOT EXISTS "channel" text NOT NULL DEFAULT 'linkedin';
ALTER TABLE "linkedin_accounts" ADD COLUMN IF NOT EXISTS "phone" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linkedin_accounts_workspace_channel_idx" ON "linkedin_accounts" ("workspace_id", "channel");
