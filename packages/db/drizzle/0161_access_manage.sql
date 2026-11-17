-- Early access (spec 2026-11-17): the access:manage permission lets CustomerOps staff approve or reject
-- self-signups and set a workspace's plan and feature switches. Owner and admin carry every catalog
-- permission (backfill-rbac.ts); Customer Success runs onboarding, so it gets it too. It only matters in
-- the internal Skout workspace: every COPS route also requires ops:access there.
INSERT INTO "permissions" ("key", "description", "category")
VALUES ('access:manage', 'Approve early access requests and set workspace plans and feature switches (Skout staff).', 'ops')
ON CONFLICT DO NOTHING;
INSERT INTO "role_permissions" ("role_id", "permission_key")
SELECT "id", 'access:manage' FROM "roles" WHERE "workspace_id" IS NULL AND "key" IN ('owner', 'admin', 'cs')
ON CONFLICT DO NOTHING;
