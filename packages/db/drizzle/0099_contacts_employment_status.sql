-- Adds the enrichment employment-verification state to CRM contacts.
ALTER TABLE "contacts"
  ADD COLUMN IF NOT EXISTS "employment_status" text DEFAULT 'discovery_candidate';
