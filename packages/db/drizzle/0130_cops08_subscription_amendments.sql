-- COPS-08 amendments (Bible p.37): a change of seats or term is appended; nothing is rewritten.
-- New table; idempotent: safe to run twice.
--
-- migration-safety: the DROP TRIGGER only makes the CREATE TRIGGER re-runnable on this new table.
-- The trigger rejects UPDATE, so an amendment can never be edited after the fact. DELETE is left
-- alone on purpose: the row goes with its subscription when a workspace is deleted.

CREATE TABLE IF NOT EXISTS "subscription_amendments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE cascade,
	"subscription_id" uuid NOT NULL REFERENCES "public"."subscriptions"("id") ON DELETE cascade,
	"seq" integer NOT NULL,
	"seats" integer,
	"term_months" integer,
	"reason" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"created_by" uuid REFERENCES "public"."users"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_amendments_seq_unique" UNIQUE("subscription_id", "seq")
);
CREATE INDEX IF NOT EXISTS "subscription_amendments_workspace_idx" ON "subscription_amendments" ("workspace_id");

CREATE OR REPLACE FUNCTION cops_subscription_amendments_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'subscription_amendments is append-only: add a new amendment instead';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS subscription_amendments_append_only ON "subscription_amendments";
CREATE TRIGGER subscription_amendments_append_only BEFORE UPDATE ON "subscription_amendments"
  FOR EACH ROW EXECUTE FUNCTION cops_subscription_amendments_append_only();
