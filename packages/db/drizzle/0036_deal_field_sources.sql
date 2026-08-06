-- R16.3 — per-field provenance on deals, so LLM-extracted budget/timeline (amount/closeDate)
-- can be auto-filled the same way R13.3 built for contacts/companies, with manual edits winning
-- forever.

ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "field_sources" jsonb DEFAULT '{}'::jsonb NOT NULL;
