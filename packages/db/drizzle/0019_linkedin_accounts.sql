-- LinkedIn accounts for Unipile-powered sequence outreach (server-side, no extension).
CREATE TABLE IF NOT EXISTS "linkedin_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "unipile_account_id" text NOT NULL,
  "display_name" text,
  "linkedin_url" text,
  "status" text NOT NULL DEFAULT 'active',
  "daily_send_limit" integer NOT NULL DEFAULT 40,
  "sent_count" integer NOT NULL DEFAULT 0,
  "last_used_at" timestamp with time zone,
  "last_error" text,
  "is_default" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "linkedin_accounts_workspace_unipile_unique"
  ON "linkedin_accounts" ("workspace_id", "unipile_account_id");
