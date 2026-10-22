-- COPS-14 part C (custom roles): a workspace cannot have two custom roles with the same name.
-- System roles (workspace_id NULL) are not affected.
CREATE UNIQUE INDEX IF NOT EXISTS "roles_workspace_name_uidx" ON "roles" ("workspace_id", lower("name")) WHERE "workspace_id" IS NOT NULL;
