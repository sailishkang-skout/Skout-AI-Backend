-- COPS-07: versioned admin configuration. One row per saved version; rows are never edited.
-- Idempotent: safe to run twice.

CREATE TABLE IF NOT EXISTS "cops_config_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "key" text NOT NULL,
  "version" integer NOT NULL,
  "value" jsonb NOT NULL,
  "reason" text NOT NULL,
  "restored_from_version" integer,
  "created_by" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "cops_config_versions_version_ck" CHECK ("version" >= 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS "cops_config_versions_uq"
  ON "cops_config_versions" ("workspace_id", "kind", "key", "version");

-- A change is a new version: rows cannot be updated. (Deleting a workspace still cascades.)
CREATE OR REPLACE FUNCTION cops_config_versions_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'cops_config_versions rows are immutable; save a new version';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "cops_config_versions_no_update" ON "cops_config_versions";
CREATE TRIGGER "cops_config_versions_no_update" BEFORE UPDATE ON "cops_config_versions"
  FOR EACH ROW EXECUTE FUNCTION cops_config_versions_immutable();
