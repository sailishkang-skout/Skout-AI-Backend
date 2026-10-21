-- COPS-12 (Bible p.52, 54-56): SLA clocks per ticket, incidents linked to tickets with one
-- investigation owner, and release / verification tracking on the ticket.
CREATE TABLE IF NOT EXISTS "sla_clocks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "ticket_id" uuid NOT NULL REFERENCES "engineering_tickets"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "calendar" text NOT NULL,
  "target_minutes" integer NOT NULL,
  "used_minutes" integer DEFAULT 0 NOT NULL,
  "started_at" timestamp with time zone NOT NULL,
  "running_since" timestamp with time zone,
  "due_at" timestamp with time zone,
  "met_at" timestamp with time zone,
  "breached_at" timestamp with time zone,
  "at_risk_notified_at" timestamp with time zone,
  "breach_notified_at" timestamp with time zone,
  "policy_version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sla_clocks_kind_check" CHECK ("kind" IN ('response', 'resolution')),
  CONSTRAINT "sla_clocks_calendar_check" CHECK ("calendar" IN ('24x7', 'business'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sla_clocks_ticket_kind_uq" ON "sla_clocks" ("ticket_id", "kind");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sla_clocks_due_idx" ON "sla_clocks" ("workspace_id", "due_at") WHERE "met_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN IF NOT EXISTS "owner_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN IF NOT EXISTS "started_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN IF NOT EXISTS "ended_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN IF NOT EXISTS "workaround" text;
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN IF NOT EXISTS "root_cause" text;
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN IF NOT EXISTS "follow_ups" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN IF NOT EXISTS "customer_update" text;
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN IF NOT EXISTS "customer_update_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "incident_ticket_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "incident_id" uuid NOT NULL REFERENCES "incidents"("id") ON DELETE CASCADE,
  "ticket_id" uuid NOT NULL REFERENCES "engineering_tickets"("id") ON DELETE CASCADE,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "incident_ticket_links_ticket_uq" ON "incident_ticket_links" ("ticket_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "incident_ticket_links_incident_idx" ON "incident_ticket_links" ("workspace_id", "incident_id");
--> statement-breakpoint
ALTER TABLE "engineering_tickets" ADD COLUMN IF NOT EXISTS "release_id" text;
--> statement-breakpoint
ALTER TABLE "engineering_tickets" ADD COLUMN IF NOT EXISTS "fixed_in_version" text;
--> statement-breakpoint
ALTER TABLE "engineering_tickets" ADD COLUMN IF NOT EXISTS "deployed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "engineering_tickets" ADD COLUMN IF NOT EXISTS "qa_verified_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "engineering_tickets" ADD COLUMN IF NOT EXISTS "qa_verified_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "engineering_tickets" ADD COLUMN IF NOT EXISTS "qa_evidence" text;
--> statement-breakpoint
ALTER TABLE "engineering_tickets" ADD COLUMN IF NOT EXISTS "customer_verified_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "engineering_tickets" ADD COLUMN IF NOT EXISTS "customer_verified_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "engineering_tickets" ADD COLUMN IF NOT EXISTS "customer_evidence" text;
--> statement-breakpoint
ALTER TABLE "engineering_tickets" ADD COLUMN IF NOT EXISTS "first_response_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "engineering_tickets" ADD COLUMN IF NOT EXISTS "reopen_count" integer DEFAULT 0 NOT NULL;
