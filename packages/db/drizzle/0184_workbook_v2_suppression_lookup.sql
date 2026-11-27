-- WB2-027: finding out whether the people in workbook rows have opted out.
-- The check reads the records the contact gate already uses, matching addresses without regard to case or surrounding
-- spaces and phone numbers by their digits. These indexes keep it quick enough to repeat before every operation.
CREATE INDEX IF NOT EXISTS "contacts_workspace_email_match_idx" ON "contacts" ("workspace_id", lower(btrim("email")));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contact_channels_email_match_idx" ON "contact_channels" ("workspace_id", lower(btrim("value"))) WHERE "channel" = 'email';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contact_channels_suppressed_phone_idx" ON "contact_channels" ("workspace_id", regexp_replace("value", '[^0-9]', '', 'g')) WHERE "suppressed" AND "channel" = 'phone';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contact_channels_suppressed_contact_idx" ON "contact_channels" ("workspace_id", "contact_id") WHERE "suppressed";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consents_revoked_email_idx" ON "consents" ("workspace_id", lower("subject_id")) WHERE "type" = 'email' AND "revoked_at" IS NOT NULL;
