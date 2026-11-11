-- A subscription is built from the proposal's recurring lines, so each item keeps its name.
ALTER TABLE "subscription_items" ADD COLUMN IF NOT EXISTS "description" text;
