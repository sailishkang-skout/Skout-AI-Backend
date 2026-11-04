-- COPS-08 subscriptions (Bible p.36, p.77): the subscription of an account, what it is made of,
-- and one bill per billing period. New tables only; idempotent: safe to run twice.

CREATE TABLE IF NOT EXISTS "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE cascade,
	"account_id" uuid NOT NULL REFERENCES "public"."companies"("id") ON DELETE cascade,
	"opportunity_id" uuid NOT NULL REFERENCES "public"."deals"("id") ON DELETE cascade,
	"status" text DEFAULT 'active' NOT NULL,
	"billing" text NOT NULL,
	"currency" text NOT NULL,
	"cadence" text NOT NULL,
	"term_months" integer NOT NULL,
	"term_start" timestamp with time zone NOT NULL,
	"term_end" timestamp with time zone NOT NULL,
	"payment_terms_net_days" integer DEFAULT 30 NOT NULL,
	"provider_subscription_id" text,
	"provider_plan_id" text,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid REFERENCES "public"."users"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_status_check" CHECK ("status" IN ('active', 'past_due', 'restricted', 'suspended', 'closed')),
	CONSTRAINT "subscriptions_billing_check" CHECK ("billing" IN ('payment_link', 'invoiced', 'provider')),
	CONSTRAINT "subscriptions_cadence_check" CHECK ("cadence" IN ('monthly', 'annual'))
);
CREATE INDEX IF NOT EXISTS "subscriptions_workspace_status_idx" ON "subscriptions" ("workspace_id", "status");
-- An account has at most one subscription that is not closed.
CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_one_open_per_account" ON "subscriptions" ("account_id") WHERE "status" <> 'closed';

CREATE TABLE IF NOT EXISTS "subscription_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE cascade,
	"subscription_id" uuid NOT NULL REFERENCES "public"."subscriptions"("id") ON DELETE cascade,
	"kind" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_amount_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "subscription_items_subscription_idx" ON "subscription_items" ("subscription_id");
CREATE INDEX IF NOT EXISTS "subscription_items_workspace_idx" ON "subscription_items" ("workspace_id");

CREATE TABLE IF NOT EXISTS "subscription_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE cascade,
	"subscription_id" uuid NOT NULL REFERENCES "public"."subscriptions"("id") ON DELETE cascade,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"payment_request_id" uuid REFERENCES "public"."payment_requests"("id") ON DELETE set null,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_invoices_period_unique" UNIQUE("subscription_id", "period_start"),
	CONSTRAINT "subscription_invoices_status_check" CHECK ("status" IN ('open', 'paid', 'void'))
);
CREATE INDEX IF NOT EXISTS "subscription_invoices_workspace_status_idx" ON "subscription_invoices" ("workspace_id", "status", "due_at");
