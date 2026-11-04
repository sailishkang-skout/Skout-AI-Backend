-- COPS-08 e-signature (Bible p.32, p.77): one envelope per send of a contract version, and every
-- provider event received for it. New tables only; idempotent: safe to run twice.

CREATE TABLE IF NOT EXISTS "signature_envelopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE cascade,
	"contract_id" uuid NOT NULL REFERENCES "public"."contracts"("id") ON DELETE cascade,
	"contract_version" integer NOT NULL,
	"provider" text NOT NULL,
	"provider_ref" text,
	"status" text DEFAULT 'pending_send' NOT NULL,
	"template_key" text,
	"signers" jsonb NOT NULL,
	"merge_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sent_by" uuid REFERENCES "public"."users"("id") ON DELETE set null,
	"sent_at" timestamp with time zone,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signature_envelopes_status_check" CHECK ("status" IN ('pending_send', 'failed', 'sent', 'viewed', 'expired', 'declined', 'signed'))
);
CREATE INDEX IF NOT EXISTS "signature_envelopes_contract_idx" ON "signature_envelopes" ("contract_id");
CREATE INDEX IF NOT EXISTS "signature_envelopes_workspace_status_idx" ON "signature_envelopes" ("workspace_id", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "signature_envelopes_provider_ref_unique" ON "signature_envelopes" ("provider", "provider_ref") WHERE "provider_ref" IS NOT NULL;
-- A contract version is out for signature at most once at a time.
CREATE UNIQUE INDEX IF NOT EXISTS "signature_envelopes_one_live_per_version" ON "signature_envelopes" ("contract_id", "contract_version") WHERE "status" IN ('pending_send', 'sent', 'viewed');

-- workspace_id and envelope_id are NULL for an event that matches no envelope; it is kept for reconciliation.
CREATE TABLE IF NOT EXISTS "signature_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid REFERENCES "public"."workspaces"("id") ON DELETE cascade,
	"envelope_id" uuid REFERENCES "public"."signature_envelopes"("id") ON DELETE cascade,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"status" text,
	"occurred_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" text DEFAULT 'received' NOT NULL,
	"refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "signature_events_provider_event_unique" UNIQUE("provider", "provider_event_id")
);
CREATE INDEX IF NOT EXISTS "signature_events_envelope_idx" ON "signature_events" ("envelope_id");
CREATE INDEX IF NOT EXISTS "signature_events_workspace_idx" ON "signature_events" ("workspace_id");
