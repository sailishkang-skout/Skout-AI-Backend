-- whatsapp_outreach_jobs was missing the index its LinkedIn twin
-- (linkedin_outreach_jobs_pending_idx, added in 0018) has. Without it,
-- WhatsappOutreachService.listPending()'s WHERE workspace_id AND status ... ORDER BY
-- created_at is a sequential scan, and workspace_id's ON DELETE CASCADE FK has no
-- supporting index.
CREATE INDEX IF NOT EXISTS "whatsapp_outreach_jobs_pending_idx"
  ON "whatsapp_outreach_jobs" ("workspace_id", "status", "created_at")
  WHERE "status" = 'pending';
