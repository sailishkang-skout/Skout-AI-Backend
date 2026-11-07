-- COPS-15: the ops:access permission and the "Ops access" system role that carries it.
-- No other role gets ops:access; it is granted per member in the internal workspace.
INSERT INTO "permissions" ("key", "description", "category")
VALUES ('ops:access', 'Use the CustomerOps portal (Skout staff only).', 'ops')
ON CONFLICT DO NOTHING;
INSERT INTO "roles" ("workspace_id", "key", "name", "description", "is_system")
SELECT NULL, 'ops_access', 'Ops access', 'Can use the CustomerOps portal. Internal Skout workspace only.', true
WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "workspace_id" IS NULL AND "key" = 'ops_access');
INSERT INTO "role_permissions" ("role_id", "permission_key")
SELECT "id", 'ops:access' FROM "roles" WHERE "workspace_id" IS NULL AND "key" = 'ops_access'
ON CONFLICT DO NOTHING;
