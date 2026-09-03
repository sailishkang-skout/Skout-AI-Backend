-- §8.12 SS-02 — additive contract date for retention renewal-risk detection.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "contract_end_date" date;