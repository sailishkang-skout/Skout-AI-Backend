-- §8.12 CRM Intelligence (Enterprise Completion Plan) — BuyingCommittee and RetentionRule,
-- the two entities the vision doc identifies as missing from an otherwise-solid CRM core.
-- See docs/adr/0002-canonical-operating-model-wave-1.md for the Wave 1/Wave 2 split this
-- follows, and packages/db/src/schema/crm-intelligence.ts for the Drizzle definitions.
--
-- Hand-authored for the same reason 0050 was (drizzle-kit cannot run in this environment —
-- see drizzle-baseline/README.md and 0022_crm_entities.sql). Every table here is new — no
-- existing table, column, or constraint is altered or dropped.

CREATE TABLE IF NOT EXISTS "buying_committees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"deal_id" uuid,
	"company_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "buying_committees_deal_unique" UNIQUE("deal_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "buying_committee_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"committee_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"role" text DEFAULT 'unknown' NOT NULL,
	"influence" integer DEFAULT 3 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "buying_committee_members_committee_contact_unique" UNIQUE("committee_id","contact_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "retention_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"classification" text NOT NULL,
	"entity_type" text NOT NULL,
	"criteria" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "buying_committees" ADD CONSTRAINT "buying_committees_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "buying_committees" ADD CONSTRAINT "buying_committees_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "buying_committees" ADD CONSTRAINT "buying_committees_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "buying_committee_members" ADD CONSTRAINT "buying_committee_members_committee_id_buying_committees_id_fk" FOREIGN KEY ("committee_id") REFERENCES "public"."buying_committees"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "buying_committee_members" ADD CONSTRAINT "buying_committee_members_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "retention_rules" ADD CONSTRAINT "retention_rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "retention_rules" ADD CONSTRAINT "retention_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "buying_committees_workspace_id_idx" ON "buying_committees" USING btree ("workspace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "buying_committees_deal_id_idx" ON "buying_committees" USING btree ("deal_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "buying_committees_company_id_idx" ON "buying_committees" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "buying_committee_members_committee_id_idx" ON "buying_committee_members" USING btree ("committee_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "retention_rules_workspace_id_idx" ON "retention_rules" USING btree ("workspace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "retention_rules_workspace_active_idx" ON "retention_rules" USING btree ("workspace_id","is_active");
