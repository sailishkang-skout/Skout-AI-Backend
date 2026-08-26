-- §8.12 CRM Intelligence Task 29 (Enterprise Completion Plan) — extends RetentionRules.classify()
-- from activities-only (0053) to contacts (lifecycleStage) and companies (status). Additive,
-- nullable, no default that would imply existing rows are already classified — matches the same
-- pattern 0053 used, and every other migration this engagement has run (no backfill; no DB
-- access from this sandbox to run one safely against real customer data).

ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "retention_classification" text;
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "retention_classification" text;
