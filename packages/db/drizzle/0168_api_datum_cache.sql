-- PAPI-034 (public API PRD CRED-4, §9.6): the 30-day "same datum, same workspace, no charge" cache.
CREATE TABLE IF NOT EXISTS "api_datum_cache" (
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "subject_key" text NOT NULL,
  "datum_type" text NOT NULL,
  "value" jsonb NOT NULL,
  "delivered_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "api_datum_cache_pk" PRIMARY KEY ("workspace_id", "subject_key", "datum_type"),
  CONSTRAINT "api_datum_cache_type_check" CHECK ("datum_type" IN ('email', 'phone', 'person', 'company', 'company_jobs')),
  CONSTRAINT "api_datum_cache_subject_check" CHECK (char_length("subject_key") BETWEEN 1 AND 300)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_datum_cache_subject_idx" ON "api_datum_cache" ("subject_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_datum_cache_delivered_idx" ON "api_datum_cache" ("delivered_at");
