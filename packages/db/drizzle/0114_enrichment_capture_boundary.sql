CREATE UNIQUE INDEX IF NOT EXISTS "companies_workspace_entity_unique_idx"
  ON "companies" ("workspace_id", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "contacts_workspace_entity_unique_idx"
  ON "contacts" ("workspace_id", "id");

CREATE TABLE IF NOT EXISTS "company_person_discoveries" (
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "company_id" uuid NOT NULL,
  "contact_id" uuid NOT NULL,
  "source" text NOT NULL,
  "captured_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "company_person_discoveries_pkey" PRIMARY KEY ("workspace_id", "company_id", "contact_id"),
  CONSTRAINT "company_person_discoveries_company_workspace_fk"
    FOREIGN KEY ("workspace_id", "company_id")
    REFERENCES "companies"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "company_person_discoveries_contact_workspace_fk"
    FOREIGN KEY ("workspace_id", "contact_id")
    REFERENCES "contacts"("workspace_id", "id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "company_person_discoveries_workspace_contact_idx"
  ON "company_person_discoveries" ("workspace_id", "contact_id");

CREATE TABLE IF NOT EXISTS "enrichment_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "entity_type" text NOT NULL CHECK ("entity_type" IN ('person', 'company')),
  "entity_id" text NOT NULL,
  "field_hashes" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "raw_data" jsonb NOT NULL,
  "captured_at" timestamptz NOT NULL DEFAULT now(),
  "captured_via" text NOT NULL CHECK ("captured_via" IN ('EXTENSION', 'ENRICHMENT_API', 'MANUAL_IMPORT')),
  "captured_by" uuid REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "enrichment_snapshots_workspace_entity_idx"
  ON "enrichment_snapshots" ("workspace_id", "entity_type", "entity_id", "captured_at");

CREATE TABLE IF NOT EXISTS "enrichment_change_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "entity_type" text NOT NULL CHECK ("entity_type" IN ('person', 'company')),
  "entity_id" text NOT NULL,
  "field" text NOT NULL,
  "change_type" text NOT NULL CHECK ("change_type" IN ('FIELD_UPDATED', 'FIELD_ADDED', 'FIELD_REMOVED')),
  "old_value" jsonb,
  "new_value" jsonb,
  "is_job_change" boolean NOT NULL DEFAULT false,
  "detected_at" timestamptz NOT NULL DEFAULT now(),
  "notified_at" timestamptz
);

CREATE INDEX IF NOT EXISTS "enrichment_change_events_workspace_detected_idx"
  ON "enrichment_change_events" ("workspace_id", "detected_at");
CREATE INDEX IF NOT EXISTS "enrichment_change_events_workspace_job_change_idx"
  ON "enrichment_change_events" ("workspace_id", "is_job_change", "detected_at");
CREATE INDEX IF NOT EXISTS "enrichment_change_events_workspace_entity_idx"
  ON "enrichment_change_events" ("workspace_id", "entity_type", "entity_id");
