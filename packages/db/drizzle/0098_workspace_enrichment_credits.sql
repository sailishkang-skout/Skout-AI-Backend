ALTER TABLE "workspaces"
  ADD COLUMN IF NOT EXISTS "enrichment_credits" integer NOT NULL DEFAULT 100;
