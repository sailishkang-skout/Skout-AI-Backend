-- COPS-11 customer success health (Bible p.49): the account carries its current score, state,
-- renewal risk and CSM (the Bible's Success fields); every computation is kept with its factor
-- breakdown for explanation and trend; each workspace's model is versioned.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "health_score" integer;
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "health_state" text;
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "renewal_risk" text;
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "csm_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "health_computed_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "companies_workspace_health_idx" ON "companies" ("workspace_id", "health_state");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cops_health_models" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "config" jsonb NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cops_health_models_version_uq" ON "cops_health_models" ("workspace_id", "version");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cops_health_scores" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "score" integer NOT NULL,
  "state" text NOT NULL,
  "renewal_risk" text NOT NULL,
  "dimensions" jsonb NOT NULL,
  "factors" jsonb NOT NULL,
  "model_version" integer NOT NULL,
  "computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cops_health_scores_account_idx" ON "cops_health_scores" ("workspace_id", "account_id", "computed_at");
