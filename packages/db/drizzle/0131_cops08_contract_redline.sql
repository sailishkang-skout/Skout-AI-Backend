-- COPS-08 (Bible p.32): where a contract stands in negotiation. NULL means it was never redlined.
-- Additive and idempotent.

ALTER TABLE "contracts" ADD COLUMN IF NOT EXISTS "redline_status" text;
