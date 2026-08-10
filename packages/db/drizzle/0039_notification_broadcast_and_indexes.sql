-- R21.3 — reconciles the two independently-built R17.1 notification systems: allows a
-- workspace-wide broadcast notification (no specific assignee, e.g. an unassigned task's
-- reminder) by dropping the NOT NULL on user_id, and adds indexes for the entityType+entityId
-- lookups resolveNotificationsForEntity() needs to auto-resolve a notification once the
-- underlying task/step/draft no longer needs attention.
ALTER TABLE "notifications" ALTER COLUMN "user_id" DROP NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_workspace_type_idx" ON "notifications" ("workspace_id","type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_entity_idx" ON "notifications" ("entity_type","entity_id");
