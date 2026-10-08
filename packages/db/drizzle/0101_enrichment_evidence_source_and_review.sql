ALTER TABLE "evidence_ledger" ADD COLUMN IF NOT EXISTS "source_url" text;

CREATE INDEX IF NOT EXISTS "evidence_ledger_retention_until_idx"
  ON "evidence_ledger" ("retention_until")
  WHERE "retention_until" IS NOT NULL;

ALTER TABLE "enrichment_change_events" ADD COLUMN IF NOT EXISTS "reviewed_at" timestamptz;
ALTER TABLE "enrichment_change_events" ADD COLUMN IF NOT EXISTS "reviewed_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;
