-- COPS-05: onboarding email sends, follow-up per WelcomeEmailSent, activation model, stalled-onboarding signals.
-- Idempotent: safe to run twice.

CREATE TABLE IF NOT EXISTS "cops_onboarding_email_sends" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "provisioning_id" uuid REFERENCES "cops_provisionings"("id") ON DELETE SET NULL,
  "contact_id" uuid REFERENCES "contacts"("id") ON DELETE SET NULL,
  "to_email" text NOT NULL,
  "template_key" text NOT NULL,
  "template_version" integer NOT NULL,
  "subject" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "status" text NOT NULL DEFAULT 'queued',
  "provider_message_id" text,
  "is_resend" boolean NOT NULL DEFAULT false,
  "reason" text,
  "actor_id" uuid,
  "error" text,
  "sent_at" timestamptz,
  "delivered_at" timestamptz,
  "bounced_at" timestamptz,
  "opened_at" timestamptz,
  "clicked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "cops_onboarding_email_sends_status_ck" CHECK ("status" IN ('queued', 'sent', 'delivered', 'bounced', 'failed')),
  CONSTRAINT "cops_onboarding_email_sends_resend_reason_ck" CHECK (NOT "is_resend" OR "reason" IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS "cops_onboarding_email_sends_key_uq"
  ON "cops_onboarding_email_sends" ("workspace_id", "idempotency_key");
-- One first send per account and recipient; every further send is an explicit re-send.
CREATE UNIQUE INDEX IF NOT EXISTS "cops_onboarding_email_sends_first_uq"
  ON "cops_onboarding_email_sends" ("workspace_id", "account_id", lower("to_email")) WHERE NOT "is_resend";
CREATE INDEX IF NOT EXISTS "cops_onboarding_email_sends_account_idx"
  ON "cops_onboarding_email_sends" ("workspace_id", "account_id", "created_at");

CREATE TABLE IF NOT EXISTS "cops_follow_ups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "source_event_id" uuid NOT NULL,
  "email_send_id" uuid REFERENCES "cops_onboarding_email_sends"("id") ON DELETE SET NULL,
  "mode" text NOT NULL,
  "enrollment_id" uuid REFERENCES "sequence_enrollments"("id") ON DELETE SET NULL,
  "task_id" uuid REFERENCES "tasks"("id") ON DELETE SET NULL,
  "task_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "cops_follow_ups_mode_ck" CHECK ("mode" IN ('sequence', 'task')),
  -- Never neither: a sequence follow-up has its enrollment, a task follow-up its task (at creation).
  CONSTRAINT "cops_follow_ups_target_ck" CHECK (
    ("mode" = 'sequence' AND "task_id" IS NULL) OR ("mode" = 'task' AND "enrollment_id" IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS "cops_follow_ups_event_uq" ON "cops_follow_ups" ("workspace_id", "source_event_id");
CREATE INDEX IF NOT EXISTS "cops_follow_ups_account_idx" ON "cops_follow_ups" ("workspace_id", "account_id");
CREATE INDEX IF NOT EXISTS "cops_follow_ups_enrollment_idx" ON "cops_follow_ups" ("enrollment_id") WHERE "enrollment_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "cops_activation_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "key" text NOT NULL,
  "version" integer NOT NULL,
  "segment" text,
  "milestones" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "cops_activation_templates_version_uq"
  ON "cops_activation_templates" (coalesce("workspace_id", '00000000-0000-0000-0000-000000000000'::uuid), "key", coalesce("segment", ''), "version");

-- Templates are versioned: a row is never edited, a change inserts the next version.
CREATE OR REPLACE FUNCTION cops_activation_templates_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'cops_activation_templates rows are immutable; insert a new version';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "cops_activation_templates_no_update" ON "cops_activation_templates";
CREATE TRIGGER "cops_activation_templates_no_update" BEFORE UPDATE ON "cops_activation_templates"
  FOR EACH ROW EXECUTE FUNCTION cops_activation_templates_immutable();

CREATE TABLE IF NOT EXISTS "cops_onboarding_instances" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "provisioning_id" uuid REFERENCES "cops_provisionings"("id") ON DELETE SET NULL,
  "customer_workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE SET NULL,
  "template_id" uuid NOT NULL REFERENCES "cops_activation_templates"("id"),
  "template_key" text NOT NULL,
  "template_version" integer NOT NULL,
  "activation_pct" integer NOT NULL DEFAULT 0,
  "first_login_at" timestamptz,
  "activated_at" timestamptz,
  "handoff_task_id" uuid REFERENCES "tasks"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "cops_onboarding_instances_pct_ck" CHECK ("activation_pct" BETWEEN 0 AND 100)
);
CREATE UNIQUE INDEX IF NOT EXISTS "cops_onboarding_instances_account_uq" ON "cops_onboarding_instances" ("workspace_id", "account_id");
CREATE INDEX IF NOT EXISTS "cops_onboarding_instances_customer_ws_idx" ON "cops_onboarding_instances" ("customer_workspace_id");

CREATE TABLE IF NOT EXISTS "cops_onboarding_milestones" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "instance_id" uuid NOT NULL REFERENCES "cops_onboarding_instances"("id") ON DELETE CASCADE,
  "key" text NOT NULL,
  "label" text NOT NULL,
  "weight" integer NOT NULL,
  "required" boolean NOT NULL DEFAULT false,
  "source" text NOT NULL,
  "completed_at" timestamptz,
  "evidence" jsonb,
  CONSTRAINT "cops_onboarding_milestones_source_ck" CHECK ("source" IN ('event', 'manual')),
  CONSTRAINT "cops_onboarding_milestones_weight_ck" CHECK ("weight" >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "cops_onboarding_milestones_key_uq" ON "cops_onboarding_milestones" ("instance_id", "key");

CREATE TABLE IF NOT EXISTS "cops_milestone_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "milestone_id" uuid NOT NULL REFERENCES "cops_onboarding_milestones"("id") ON DELETE CASCADE,
  "source_ref" text NOT NULL,
  "source_type" text NOT NULL,
  "actor_id" uuid,
  "reason" text,
  "occurred_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "cops_milestone_events_ref_uq" ON "cops_milestone_events" ("milestone_id", "source_ref");

CREATE TABLE IF NOT EXISTS "cops_onboarding_signals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "instance_id" uuid NOT NULL REFERENCES "cops_onboarding_instances"("id") ON DELETE CASCADE,
  "trigger" text NOT NULL,
  "task_id" uuid REFERENCES "tasks"("id") ON DELETE SET NULL,
  "fired_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "cops_onboarding_signals_once_uq" ON "cops_onboarding_signals" ("instance_id", "trigger");

-- One onboarding follow-up sequence per workspace (the default cadence is created on first use).
CREATE UNIQUE INDEX IF NOT EXISTS "sequences_cops_followup_uq"
  ON "sequences" ("workspace_id") WHERE "template_key" = 'cops_onboarding_followup' AND "status" <> 'archived';

-- Per-workspace onboarding settings (Appendix C: "critical support escalation if configured").
CREATE TABLE IF NOT EXISTS "cops_onboarding_settings" (
  "workspace_id" uuid PRIMARY KEY REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "stop_on_critical_escalation" boolean NOT NULL DEFAULT false,
  "updated_by" uuid,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

-- System default activation template v1 (Bible p.45 example; weights pending Product, COPS-05 Q2).
-- Login alone never activates: first_login has weight 0 and is not required.
INSERT INTO "cops_activation_templates" ("workspace_id", "key", "version", "segment", "milestones")
SELECT NULL, 'default_trial', 1, NULL, '[
  {"key": "invitation_accepted", "label": "Invitation accepted", "weight": 0, "required": false, "source": "event", "event_types": ["invite.accepted"]},
  {"key": "first_login", "label": "First login", "weight": 0, "required": false, "source": "event", "event_types": ["auth.login_success"]},
  {"key": "crm_connected", "label": "CRM connected", "weight": 35, "required": true, "source": "event", "event_types": ["integration.crm_connected"]},
  {"key": "first_search", "label": "First search", "weight": 30, "required": true, "source": "event", "event_types": ["product.search"]},
  {"key": "first_export", "label": "First export", "weight": 35, "required": true, "source": "event", "event_types": ["product.export"]},
  {"key": "team_invited", "label": "Team member invited", "weight": 0, "required": false, "source": "event", "event_types": ["invite.sent"]},
  {"key": "success_review", "label": "Success review completed", "weight": 0, "required": false, "source": "manual", "event_types": []}
]'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM "cops_activation_templates" WHERE "workspace_id" IS NULL AND "key" = 'default_trial' AND "version" = 1
);
