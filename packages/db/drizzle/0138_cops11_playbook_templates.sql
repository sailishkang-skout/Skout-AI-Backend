-- COPS-11: a workflow seeded from a template (the success playbooks) records its template key,
-- so a workspace has each playbook once and its runs can be found as playbook enrollments.
ALTER TABLE "automations" ADD COLUMN IF NOT EXISTS "template_key" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "automations_template_key_uq" ON "automations" ("workspace_id", "template_key") WHERE "template_key" IS NOT NULL;
