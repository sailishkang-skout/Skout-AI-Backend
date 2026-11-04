-- COPS-08 approval engine (Bible p.34, p.77). One row per approval request for a proposal version,
-- and one decision row per approver role. New tables only; idempotent: safe to run twice.

CREATE TABLE IF NOT EXISTS "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE cascade,
	"opportunity_id" uuid NOT NULL REFERENCES "public"."deals"("id") ON DELETE cascade,
	"proposal_id" uuid NOT NULL REFERENCES "public"."proposals"("id") ON DELETE cascade,
	"proposal_version" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"required_approvers" jsonb NOT NULL,
	"matched_rules" jsonb NOT NULL,
	"terms" jsonb NOT NULL,
	"policy_version" integer DEFAULT 0 NOT NULL,
	"requested_by" uuid REFERENCES "public"."users"("id") ON DELETE set null,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status_reason" text,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "approvals_status_check" CHECK ("status" IN ('pending', 'approved', 'rejected', 'voided', 'expired'))
);
CREATE INDEX IF NOT EXISTS "approvals_workspace_status_idx" ON "approvals" ("workspace_id", "status");
CREATE INDEX IF NOT EXISTS "approvals_proposal_idx" ON "approvals" ("proposal_id");
-- At most one approval that still counts per proposal version.
CREATE UNIQUE INDEX IF NOT EXISTS "approvals_one_open_per_version" ON "approvals" ("proposal_id", "proposal_version") WHERE "status" IN ('pending', 'approved');

CREATE TABLE IF NOT EXISTS "approval_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE cascade,
	"approval_id" uuid NOT NULL REFERENCES "public"."approvals"("id") ON DELETE cascade,
	"approver_role" text NOT NULL,
	"decision" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid REFERENCES "public"."users"("id") ON DELETE set null,
	"decided_at" timestamp with time zone,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_decisions_approval_role_unique" UNIQUE("approval_id", "approver_role"),
	CONSTRAINT "approval_decisions_decision_check" CHECK ("decision" IN ('pending', 'approved', 'rejected'))
);
CREATE INDEX IF NOT EXISTS "approval_decisions_workspace_idx" ON "approval_decisions" ("workspace_id");
