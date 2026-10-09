-- COPS-03 commercial workspace: proposals, contracts, payment requests, provisioning gate.
-- Idempotent so it can be re-run on databases that partially applied it.
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "deal_type" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE cascade,
	"opportunity_id" uuid NOT NULL REFERENCES "public"."deals"("id") ON DELETE cascade,
	"title" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"status_reason" text,
	"status_changed_at" timestamp with time zone,
	"status_changed_by" uuid REFERENCES "public"."users"("id") ON DELETE set null,
	"created_by" uuid REFERENCES "public"."users"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "proposals_workspace_opportunity_idx" ON "proposals" USING btree ("workspace_id","opportunity_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "proposal_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE cascade,
	"proposal_id" uuid NOT NULL REFERENCES "public"."proposals"("id") ON DELETE cascade,
	"version" integer NOT NULL,
	"currency" text NOT NULL,
	"billing_cadence" text NOT NULL,
	"term_months" integer NOT NULL,
	"discount_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"tax_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"subtotal_minor" bigint NOT NULL,
	"discount_minor" bigint NOT NULL,
	"tax_minor" bigint NOT NULL,
	"total_minor" bigint NOT NULL,
	"content_hash" text,
	"sent_at" timestamp with time zone,
	"sent_by" uuid REFERENCES "public"."users"("id") ON DELETE set null,
	"created_by" uuid REFERENCES "public"."users"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposal_versions_proposal_version_unique" UNIQUE("proposal_id","version")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "proposal_line_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE cascade,
	"version_id" uuid NOT NULL REFERENCES "public"."proposal_versions"("id") ON DELETE cascade,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_amount_minor" bigint NOT NULL,
	"discount_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"gross_minor" bigint NOT NULL,
	"discount_minor" bigint NOT NULL,
	"net_minor" bigint NOT NULL,
	CONSTRAINT "proposal_line_items_version_position_unique" UNIQUE("version_id","position")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE cascade,
	"opportunity_id" uuid NOT NULL REFERENCES "public"."deals"("id") ON DELETE cascade,
	"proposal_id" uuid REFERENCES "public"."proposals"("id") ON DELETE set null,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"status_reason" text,
	"status_changed_at" timestamp with time zone,
	"status_changed_by" uuid REFERENCES "public"."users"("id") ON DELETE set null,
	"signed_at" timestamp with time zone,
	"created_by" uuid REFERENCES "public"."users"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contracts_workspace_opportunity_idx" ON "contracts" USING btree ("workspace_id","opportunity_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contract_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE cascade,
	"contract_id" uuid NOT NULL REFERENCES "public"."contracts"("id") ON DELETE cascade,
	"version" integer NOT NULL,
	"document_url" text NOT NULL,
	"file_name" text,
	"file_sha256" text NOT NULL,
	"sent_at" timestamp with time zone,
	"sent_by" uuid REFERENCES "public"."users"("id") ON DELETE set null,
	"created_by" uuid REFERENCES "public"."users"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_versions_contract_version_unique" UNIQUE("contract_id","version")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE cascade,
	"opportunity_id" uuid NOT NULL REFERENCES "public"."deals"("id") ON DELETE cascade,
	"proposal_id" uuid REFERENCES "public"."proposals"("id") ON DELETE set null,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'requested' NOT NULL,
	"provider" text NOT NULL,
	"provider_ref" text NOT NULL,
	"checkout_url" text NOT NULL,
	"provider_payment_id" text,
	"paid_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"status_changed_at" timestamp with time zone,
	"created_by" uuid REFERENCES "public"."users"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_requests_provider_ref_unique" UNIQUE("provider","provider_ref")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_requests_workspace_opportunity_idx" ON "payment_requests" USING btree ("workspace_id","opportunity_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_provider_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid REFERENCES "public"."workspaces"("id") ON DELETE cascade,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payment_request_id" uuid REFERENCES "public"."payment_requests"("id") ON DELETE set null,
	"outcome" text NOT NULL,
	"refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_provider_events_provider_event_unique" UNIQUE("provider","provider_event_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "commercial_gate_policies" (
	"workspace_id" uuid NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE cascade,
	"deal_type" text NOT NULL,
	"policy" text NOT NULL,
	"updated_by" uuid REFERENCES "public"."users"("id") ON DELETE set null,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commercial_gate_policies_workspace_id_deal_type_pk" PRIMARY KEY("workspace_id","deal_type")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "commercial_gates" (
	"opportunity_id" uuid PRIMARY KEY NOT NULL REFERENCES "public"."deals"("id") ON DELETE cascade,
	"workspace_id" uuid NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE cascade,
	"trial_approved_at" timestamp with time zone,
	"trial_approved_by" uuid REFERENCES "public"."users"("id") ON DELETE set null,
	"override_at" timestamp with time zone,
	"override_by" uuid REFERENCES "public"."users"("id") ON DELETE set null,
	"override_reason" text,
	"fired_at" timestamp with time zone,
	"fired_event_id" uuid,
	"fired_policy" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Sent versions are immutable (COPS-03 acceptance). UPDATE of a sent version is rejected; the send
-- itself (sent_at NULL -> value) is allowed. DELETE stays possible so workspace deletion and
-- retention can cascade; the stored content_hash still detects any tampering on read.
CREATE OR REPLACE FUNCTION cops_reject_sent_version_update() RETURNS trigger AS $$
BEGIN
	IF OLD.sent_at IS NOT NULL THEN
		RAISE EXCEPTION 'sent version % of % is immutable', OLD.version, TG_TABLE_NAME USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS proposal_versions_immutable_when_sent ON "proposal_versions";
--> statement-breakpoint
CREATE TRIGGER proposal_versions_immutable_when_sent BEFORE UPDATE ON "proposal_versions"
	FOR EACH ROW EXECUTE FUNCTION cops_reject_sent_version_update();
--> statement-breakpoint
DROP TRIGGER IF EXISTS contract_versions_immutable_when_sent ON "contract_versions";
--> statement-breakpoint
CREATE TRIGGER contract_versions_immutable_when_sent BEFORE UPDATE ON "contract_versions"
	FOR EACH ROW EXECUTE FUNCTION cops_reject_sent_version_update();
--> statement-breakpoint
-- Line items of a sent proposal version cannot be inserted or changed.
CREATE OR REPLACE FUNCTION cops_reject_sent_line_item_write() RETURNS trigger AS $$
BEGIN
	IF EXISTS (SELECT 1 FROM "proposal_versions" v WHERE v.id = NEW.version_id AND v.sent_at IS NOT NULL) THEN
		RAISE EXCEPTION 'line items of a sent proposal version are immutable' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS proposal_line_items_immutable_when_sent ON "proposal_line_items";
--> statement-breakpoint
CREATE TRIGGER proposal_line_items_immutable_when_sent BEFORE INSERT OR UPDATE ON "proposal_line_items"
	FOR EACH ROW EXECUTE FUNCTION cops_reject_sent_line_item_write();
