-- §8.12 CRM Intelligence / SS-02 (renewal-risk detection) — additive column so the retention
-- signals sweep has a contract end date to compare against. No such field existed on
-- companies/deals before this (confirmed by grep across the schema). Nullable, no default:
-- existing deals have no contract term recorded until a future backfill/UI surfaces it.
--
-- NOTE: drizzle-baseline/'s snapshot lineage has drifted from the real drizzle/ history (a
-- `pnpm db:generate` run here produced a diff full of unrelated tables that already exist in
-- the real schema/DB) — this migration was hand-written to match the existing single-column
-- convention (see 0053_activities_retention_classification.sql) rather than copying that noisy
-- generated output. See packages/db/drizzle-baseline/README.md.

ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "contract_end_date" date;
