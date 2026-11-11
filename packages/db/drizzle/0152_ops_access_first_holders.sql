-- COPS-15 first rollout, no setting needed: while nobody holds Ops access yet, the members of the
-- Skout workspace (the one that provisions customer workspaces) get it once, audited.
-- After that Ops access is given only by someone who holds it (invite or People), never by a migration.
WITH ops_role AS (
  SELECT "id" FROM "roles" WHERE "workspace_id" IS NULL AND "key" = 'ops_access'
),
first_rollout AS (
  SELECT 1 AS go WHERE NOT EXISTS (
    SELECT 1 FROM "workspace_member_roles" m JOIN ops_role r ON r."id" = m."role_id"
  )
),
-- The Skout workspace: the one that provisioned the most customers, was not itself created by a
-- provisioning (every customer workspace a provisioning made is excluded, so a customer that once
-- tried provisioning before this guard existed is never picked), and is owned by a @skoutai.io
-- address (a developer's personal test workspace is never picked). None found: nobody is granted
-- here, and the first verified @skoutai.io Owner who signs in to CustomerOps gets it instead.
skout_workspaces AS (
  SELECT p."workspace_id"
  FROM "cops_provisionings" p, first_rollout
  WHERE p."workspace_id" NOT IN (
    SELECT "provisioned_workspace_id" FROM "cops_provisionings" WHERE "provisioned_workspace_id" IS NOT NULL
  )
  AND EXISTS (
    SELECT 1 FROM "workspace_members" o JOIN "users" u ON u."id" = o."user_id"
    WHERE o."workspace_id" = p."workspace_id" AND o."role" = 'owner' AND lower(u."email") LIKE '%@skoutai.io'
  )
  GROUP BY p."workspace_id"
  ORDER BY count(*) DESC, min(p."created_at")
  LIMIT 1
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
