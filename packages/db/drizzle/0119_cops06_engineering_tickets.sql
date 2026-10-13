-- COPS-06: engineering tickets, comments with a visibility scope, status history, CRM summary.
-- Idempotent: safe to run twice.

CREATE TABLE IF NOT EXISTS "engineering_tickets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "contact_id" uuid REFERENCES "contacts"("id") ON DELETE SET NULL,
  "opportunity_id" uuid REFERENCES "deals"("id") ON DELETE SET NULL,
  "milestone_id" uuid REFERENCES "cops_onboarding_milestones"("id") ON DELETE SET NULL,
  "title" text NOT NULL,
  "description" text,
  "category" text NOT NULL DEFAULT 'bug',
  "severity" text NOT NULL DEFAULT 'medium',
  "priority" text NOT NULL DEFAULT 'p3',
  "impact" text,
  "affected_feature" text,
  "environment" text NOT NULL DEFAULT 'production',
  "repro_steps" text,
  "log_refs" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "diagnostics" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL DEFAULT 'new',
  "team" text,
  "assignee_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "account_tier" text NOT NULL DEFAULT 'smb',
  "created_by" uuid,
  "escalated_at" timestamptz,
  "resolved_at" timestamptz,
  "closed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "engineering_tickets_status_ck" CHECK ("status" IN ('new', 'triage', 'assigned', 'in_progress', 'testing', 'waiting_on_customer', 'resolved', 'verified', 'closed')),
  CONSTRAINT "engineering_tickets_severity_ck" CHECK ("severity" IN ('low', 'medium', 'high', 'critical')),
  CONSTRAINT "engineering_tickets_priority_ck" CHECK ("priority" IN ('p1', 'p2', 'p3', 'p4'))
);
CREATE INDEX IF NOT EXISTS "engineering_tickets_queue_idx" ON "engineering_tickets" ("workspace_id", "status", "severity");
CREATE INDEX IF NOT EXISTS "engineering_tickets_account_idx" ON "engineering_tickets" ("workspace_id", "account_id");
CREATE INDEX IF NOT EXISTS "engineering_tickets_assignee_idx" ON "engineering_tickets" ("workspace_id", "assignee_id");

-- Visibility is part of the data model: a comment is internal unless it was published as customer-safe.
CREATE TABLE IF NOT EXISTS "ticket_comments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "ticket_id" uuid NOT NULL REFERENCES "engineering_tickets"("id") ON DELETE CASCADE,
  "visibility" text NOT NULL DEFAULT 'internal',
  "kind" text NOT NULL DEFAULT 'note',
  "body" text NOT NULL,
  "source_comment_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "author_id" uuid,
  "ai_generated" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ticket_comments_visibility_ck" CHECK ("visibility" IN ('internal', 'customer')),
  CONSTRAINT "ticket_comments_kind_ck" CHECK ("kind" IN ('note', 'update', 'ai_summary'))
);
CREATE INDEX IF NOT EXISTS "ticket_comments_ticket_idx" ON "ticket_comments" ("workspace_id", "ticket_id", "created_at");

CREATE TABLE IF NOT EXISTS "ticket_status_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "ticket_id" uuid NOT NULL REFERENCES "engineering_tickets"("id") ON DELETE CASCADE,
  "from_status" text,
  "to_status" text NOT NULL,
  "actor_id" uuid,
  "reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "ticket_status_history_ticket_idx" ON "ticket_status_history" ("workspace_id", "ticket_id", "created_at");

CREATE TABLE IF NOT EXISTS "ticket_account_summaries" (
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "open_count" integer NOT NULL DEFAULT 0,
  "max_severity" text,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("workspace_id", "account_id")
);
