-- PAPI-036 (public API PRD CRED-8): when the last low-balance alert went out, for the 24-hour limit.
ALTER TABLE "workspace_api_settings" ADD COLUMN IF NOT EXISTS "low_balance_alerted_at" timestamp with time zone;
