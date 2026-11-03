-- COPS-14 per-role tool permissions: which roles may run each agent action. Null means everyone.
ALTER TABLE "automation_policies" ADD COLUMN IF NOT EXISTS "allowed_role_ids" jsonb;
