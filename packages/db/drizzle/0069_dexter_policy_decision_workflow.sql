-- §1.2 D7/D14/D15 + §10.4/10.5 — Policy Gateway, decision views, workflow runs, Dexter plans, LinkedIn voice

CREATE TABLE IF NOT EXISTS "automation_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "action_key" text NOT NULL,
  "mode" text NOT NULL DEFAULT 'ask',
  "updated_by" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "policy_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "action_key" text NOT NULL,
  "mode" text NOT NULL,
  "outcome" text NOT NULL,
  "actor_user_id" uuid,
  "entity_type" text,
  "entity_id" text,
  "detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "decision_views" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "title" text NOT NULL,
  "kind" text NOT NULL,
  "status" text NOT NULL DEFAULT 'open',
  "recommendation" text,
  "options" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "expected_outcome" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "entity_type" text,
  "entity_id" text,
  "created_by" uuid,
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "workflow_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "name" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "correlation_id" text,
  "async_job_id" uuid,
  "steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "error_message" text,
  "created_by" uuid,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "dexter_plans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "brief" text NOT NULL,
  "proposal" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'proposed',
  "policy_mode" text,
  "policy_decision_id" uuid,
  "outcome" jsonb,
  "created_by" uuid,
  "approved_at" timestamp with time zone,
  "invoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "linkedin_voice_handoffs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "prospect_id" text NOT NULL,
  "script_text" text NOT NULL,
  "voice_choice" text NOT NULL DEFAULT 'self',
  "regional_brief_preview" text,
  "evidence_id" uuid,
  "status" text NOT NULL DEFAULT 'preview',
  "handoff_token" text NOT NULL,
  "confirmed_at" timestamp with time zone,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "automation_policies" ADD CONSTRAINT "automation_policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
 ALTER TABLE "automation_policies" ADD CONSTRAINT "automation_policies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
 ALTER TABLE "policy_decisions" ADD CONSTRAINT "policy_decisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
 ALTER TABLE "decision_views" ADD CONSTRAINT "decision_views_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
 ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
 ALTER TABLE "dexter_plans" ADD CONSTRAINT "dexter_plans_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
 ALTER TABLE "linkedin_voice_handoffs" ADD CONSTRAINT "linkedin_voice_handoffs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "automation_policies_workspace_action_uidx" ON "automation_policies" ("workspace_id","action_key");
CREATE INDEX IF NOT EXISTS "automation_policies_workspace_idx" ON "automation_policies" ("workspace_id");
CREATE INDEX IF NOT EXISTS "policy_decisions_workspace_created_idx" ON "policy_decisions" ("workspace_id","created_at");
CREATE INDEX IF NOT EXISTS "decision_views_workspace_status_idx" ON "decision_views" ("workspace_id","status");
CREATE INDEX IF NOT EXISTS "workflow_runs_workspace_created_idx" ON "workflow_runs" ("workspace_id","created_at");
CREATE INDEX IF NOT EXISTS "dexter_plans_workspace_status_idx" ON "dexter_plans" ("workspace_id","status");
CREATE UNIQUE INDEX IF NOT EXISTS "linkedin_voice_handoffs_token_uidx" ON "linkedin_voice_handoffs" ("handoff_token");
CREATE INDEX IF NOT EXISTS "linkedin_voice_handoffs_workspace_idx" ON "linkedin_voice_handoffs" ("workspace_id");
