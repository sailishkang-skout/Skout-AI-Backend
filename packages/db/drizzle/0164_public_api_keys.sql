-- PAPI-010 (public API PRD §10): customer API keys for www.skoutai.io/api/public/v1.
CREATE TABLE IF NOT EXISTS "api_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "name" text NOT NULL,
  "type" text NOT NULL,
  "prefix" text NOT NULL,
  "key_hmac" text NOT NULL,
  "scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "ip_allowlist" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "daily_credit_cap" integer,
  "monthly_credit_cap" integer,
  "expires_at" timestamp with time zone NOT NULL,
  "expiry_reminders_sent" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "last_used_at" timestamp with time zone,
  "last_used_ip" text,
  "revoked_at" timestamp with time zone,
  "revoke_reason" text,
  "replaced_by" uuid REFERENCES "api_keys"("id") ON DELETE SET NULL,
  "grace_until" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "api_keys_type_check" CHECK ("type" IN ('live', 'test')),
  CONSTRAINT "api_keys_prefix_format_check" CHECK ("prefix" ~ '^[0-9a-f]{12}$'),
  -- KEY-5 / D8: every key expires, at most 90 days after it was created.
  CONSTRAINT "api_keys_expiry_max_90_days_check" CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '90 days'),
  -- KEY-7: the rotation grace period never extends a key past its own expiry.
  CONSTRAINT "api_keys_grace_within_expiry_check" CHECK ("grace_until" IS NULL OR "grace_until" <= "expires_at"),
  CONSTRAINT "api_keys_caps_check" CHECK (("daily_credit_cap" IS NULL OR "daily_credit_cap" >= 0) AND ("monthly_credit_cap" IS NULL OR "monthly_credit_cap" >= 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_prefix_uq" ON "api_keys" ("prefix");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_keys_workspace_revoked_idx" ON "api_keys" ("workspace_id", "revoked_at");
