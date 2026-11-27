-- WB2-014 (PRD WB-2): the enrichment.run permission. Members without it can view and edit workbooks but cannot run
-- columns or push to a CRM, so cannot spend credits. Owner and admin carry it (as in backfill-rbac.ts); member does
-- not. On an empty database the roles do not exist yet and backfill-rbac grants it when it creates them.
INSERT INTO "permissions" ("key", "description", "category")
VALUES ('enrichment.run', 'Run workbook columns and push workbook data to a CRM. Spends credits.', 'enrichment')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_key")
SELECT "id", 'enrichment.run' FROM "roles" WHERE "workspace_id" IS NULL AND "key" IN ('owner', 'admin')
ON CONFLICT DO NOTHING;
