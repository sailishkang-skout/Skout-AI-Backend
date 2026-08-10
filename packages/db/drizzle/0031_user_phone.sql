-- R20.2 — Twilio click-to-call: the "agent leg" number dialed first to bridge to a prospect.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phone" text;
