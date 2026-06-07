-- Skout AI PostgreSQL schema v1 (workspace OLTP — activated records only)
-- Never store full 200M corpus here. See 06-existing-data-platform.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE prospect_activations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  prospect_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  snapshot JSONB NOT NULL DEFAULT '{}',
  record_version INT NOT NULL DEFAULT 1,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, prospect_id)
);

CREATE INDEX idx_activations_workspace ON prospect_activations (workspace_id);

-- Row-level security (enable after Supabase/auth wiring)
-- ALTER TABLE prospect_activations ENABLE ROW LEVEL SECURITY;

CREATE TABLE lists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE list_members (
  list_id UUID NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  prospect_id TEXT NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, prospect_id)
);
