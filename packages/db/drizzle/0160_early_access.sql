-- Early access approval (docs/superpowers/specs/2026-11-17-early-access-approval-design.md).
-- Every existing workspace becomes 'active' through the default: nothing changes for current users.
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "access_status" text NOT NULL DEFAULT 'active';
DO $$ BEGIN
  ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_access_status_check"
    CHECK ("access_status" IN ('pending', 'invited', 'active', 'rejected'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "access_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "email" text NOT NULL,
  "full_name" text,
  "company" text,
  "role_title" text,
  "use_case" text,
  "signup_method" text NOT NULL CHECK ("signup_method" IN ('password', 'google', 'microsoft')),
  "status" text NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'approved', 'rejected')),
  "decided_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "decided_at" timestamp with time zone,
  "decision_note" text,
  "plan_code" text,
  "credits_granted" integer,
  "invite_code_hash" text,
  "invite_code_expires_at" timestamp with time zone,
  "invite_code_redeemed_at" timestamp with time zone,
  "invite_email_sent_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "access_requests_workspace_unique" UNIQUE ("workspace_id")
);
CREATE INDEX IF NOT EXISTS "access_requests_status_created_idx" ON "access_requests" ("status", "created_at" DESC);
