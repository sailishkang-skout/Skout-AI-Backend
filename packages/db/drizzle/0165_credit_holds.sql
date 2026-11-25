-- PAPI-011 (public API PRD §10, CRED-2, CRED-5): credit reservations, and which API key spent each ledger entry.

-- 1. Ledger link to the API key. Adding a nullable column rewrites no rows, so the append-only
--    trigger is not involved. No ON DELETE action: SET NULL would UPDATE ledger rows, which the
--    trigger rejects. Keys are only deleted together with their workspace (cascade), and the
--    ledger rows go in the same statement.
ALTER TABLE "credit_transactions" ADD COLUMN IF NOT EXISTS "api_key_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_api_key_id_fk"
    FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_transactions_api_key_idx"
  ON "credit_transactions" ("api_key_id", "created_at") WHERE "api_key_id" IS NOT NULL;
--> statement-breakpoint

-- 2. Holds.
CREATE TABLE IF NOT EXISTS "credit_holds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "api_key_id" uuid NOT NULL REFERENCES "api_keys"("id") ON DELETE CASCADE,
  "request_id" text NOT NULL,
  "amount" integer NOT NULL,
  "status" text DEFAULT 'held' NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "settled_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "credit_holds_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "credit_holds_status_check" CHECK ("status" IN ('held', 'committed', 'released')),
  CONSTRAINT "credit_holds_settled_check" CHECK (("status" = 'held') = ("settled_at" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_holds_workspace_request_uq" ON "credit_holds" ("workspace_id", "request_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_holds_active_workspace_idx" ON "credit_holds" ("workspace_id") WHERE "status" = 'held';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_holds_active_expiry_idx" ON "credit_holds" ("expires_at") WHERE "status" = 'held';
