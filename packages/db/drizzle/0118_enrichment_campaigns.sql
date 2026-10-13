CREATE TABLE IF NOT EXISTS "enrichment_audiences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "filters" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "list_id" uuid REFERENCES "lists"("id") ON DELETE SET NULL,
  "stats" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enrichment_audiences_workspace_idx" ON "enrichment_audiences" ("workspace_id", "updated_at");
--> statement-breakpoint
ALTER TABLE "enrichment_campaigns"
  ADD COLUMN IF NOT EXISTS "audience_id" uuid REFERENCES "enrichment_audiences"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "sequence_id" uuid,
  ADD COLUMN IF NOT EXISTS "trigger" text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS "source_change_event_id" uuid,
  ADD COLUMN IF NOT EXISTS "draft" jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS "approved_fingerprint" text,
  ADD COLUMN IF NOT EXISTS "consent_basis" text,
  ADD COLUMN IF NOT EXISTS "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "submitted_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "submitted_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "approved_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "approved_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "review_comment" text,
  ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enrichment_campaigns_workspace_status_idx" ON "enrichment_campaigns" ("workspace_id", "status", "updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enrichment_campaigns_sequence_idx" ON "enrichment_campaigns" ("sequence_id");
--> statement-breakpoint
-- One open job-change suggestion per change event.
CREATE UNIQUE INDEX IF NOT EXISTS "enrichment_campaigns_change_event_unique_idx"
  ON "enrichment_campaigns" ("workspace_id", "source_change_event_id")
  WHERE "source_change_event_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "enrichment_campaign_recipients" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "campaign_id" uuid NOT NULL REFERENCES "enrichment_campaigns"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "prospect_id" text NOT NULL,
  "full_name" text,
  "email" text,
  "eligibility" text NOT NULL DEFAULT 'excluded' CHECK ("eligibility" IN ('eligible', 'excluded')),
  "exclusion_reason" text,
  "email_verification" text NOT NULL DEFAULT 'unverified',
  "consent_status" text NOT NULL DEFAULT 'missing',
  "decision" text NOT NULL DEFAULT 'included' CHECK ("decision" IN ('included', 'removed')),
  "decision_comment" text,
  "claims" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "approved_fingerprint" text,
  "enrollment_id" uuid,
  "sent_at" timestamptz,
  "replied_at" timestamptz,
  "bounced_at" timestamptz,
  "unsubscribed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "enrichment_campaign_recipients_campaign_prospect_unique" UNIQUE ("campaign_id", "prospect_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enrichment_campaign_recipients_enrollment_idx" ON "enrichment_campaign_recipients" ("enrollment_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enrichment_campaign_recipients_workspace_prospect_idx" ON "enrichment_campaign_recipients" ("workspace_id", "prospect_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "enrichment_campaign_reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "campaign_id" uuid NOT NULL REFERENCES "enrichment_campaigns"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "reviewer_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "decision" text NOT NULL CHECK ("decision" IN ('approved', 'rejected', 'invalidated')),
  "comment" text,
  "fingerprint" text,
  "recipient_count" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enrichment_campaign_reviews_campaign_idx" ON "enrichment_campaign_reviews" ("campaign_id", "created_at");
