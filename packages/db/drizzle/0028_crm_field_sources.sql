-- R13.3 — Auto-filled CRM/contact fields. Tracks, per field, whether the current value
-- came from enrichment/meeting-bot/call-notes (auto-filled) or a human edit ("manual").
-- A field's source flips to "manual" the moment a human edits it via PATCH — after that,
-- auto-fill must never silently overwrite it (see ContactsService.autoFill /
-- CompaniesService.autoFill in apps/crm). Hand-authored, same idempotent style as 0022/0023.

ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "field_sources" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "field_sources" jsonb DEFAULT '{}'::jsonb NOT NULL;
