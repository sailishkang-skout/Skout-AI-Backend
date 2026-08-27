-- §8.11 — Telnyx requirement group id for regulatory document fulfillment

ALTER TABLE "number_requests"
  ADD COLUMN IF NOT EXISTS "provider_requirement_group_id" text;
