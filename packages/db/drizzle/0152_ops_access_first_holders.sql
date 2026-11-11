-- COPS-15 first rollout, no setting needed: while nobody holds Ops access yet, the members of every
-- workspace that has provisioned customer workspaces (only Skout staff do that) get it once, audited.
-- After that Ops access is given only by someone who holds it (invite or People), never by a migration.
WITH ops_role AS (
  SELECT "id" FROM "roles" WHERE "workspace_id" IS NULL AND "key" = 'ops_access'
),
first_rollout AS (
  SELECT 1 AS go WHERE NOT EXISTS (
    SELECT 1 FROM "workspace_member_roles" m JOIN ops_role r ON r."id" = m."role_id"
  )
),
skout_workspaces AS (
  SELECT DISTINCT p."workspace_id" FROM "cops_provisionings" p, first_rollout
),
granted AS (
  INSERT INTO "workspace_member_roles" ("workspace_id", "user_id", "role_id")
  SELECT wm."workspace_id", wm."user_id", r."id"
  FROM "workspace_members" wm
  JOIN skout_workspaces s ON s."workspace_id" = wm."workspace_id"
  CROSS JOIN ops_role r
  ON CONFLICT DO NOTHING
  RETURNING "workspace_id", "user_id"
)
INSERT INTO "audit_logs" ("workspace_id", "actor_type", "action", "entity_type", "entity_id", "after_state")
SELECT "workspace_id", 'system', 'ops_access.granted', 'workspace_member', "user_id", '{"via":"first_rollout"}'::jsonb
FROM granted;
