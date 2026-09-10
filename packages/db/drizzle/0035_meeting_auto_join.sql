-- R16.2 — opt-in auto-join: a workspace-wide default plus a per-meeting override, consumed by
-- the meeting-auto-join worker (apps/crm/src/workers/meeting-auto-join.worker.ts).

ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "meeting_bot_auto_join_default" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN IF NOT EXISTS "auto_join_bot" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meetings_auto_join_due_idx" ON "meetings" ("auto_join_bot","bot_status","scheduled_at");
