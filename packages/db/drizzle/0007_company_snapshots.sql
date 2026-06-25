CREATE TABLE IF NOT EXISTS "company_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "domain" text NOT NULL,
  "employee_count" integer,
  "open_jobs" integer,
  "annual_revenue" bigint,
  "scraped_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "company_snapshots_domain_idx" ON "company_snapshots" ("domain");
CREATE INDEX IF NOT EXISTS "company_snapshots_domain_scraped_idx" ON "company_snapshots" ("domain", "scraped_at");
