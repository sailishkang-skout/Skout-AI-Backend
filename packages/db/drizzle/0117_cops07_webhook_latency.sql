-- COPS-07: measure payment webhook latency. provider_created_at is the provider's send time,
-- processed_at is when the event reached its outcome. Idempotent: safe to run twice.
-- Existing rows keep NULL in both columns and are left out of the latency metrics.

ALTER TABLE "payment_provider_events" ADD COLUMN IF NOT EXISTS "provider_created_at" timestamptz;
ALTER TABLE "payment_provider_events" ADD COLUMN IF NOT EXISTS "processed_at" timestamptz;
