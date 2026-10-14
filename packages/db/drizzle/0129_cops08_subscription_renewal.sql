-- COPS-08 renewals (Bible p.37): the renewal opportunity opened for a subscription term. A
-- subscription row is one term, so one nullable reference is "one renewal opportunity per term".
-- Additive and idempotent.

ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "renewal_opportunity_id" uuid REFERENCES "public"."deals"("id") ON DELETE set null;
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "renewal_opened_at" timestamptz;
