-- Where a company or deal came from (inbound, outbound, referral, ...), set by the rep in CustomerOps.
-- lead_source_detail says more: who referred it, which event or campaign.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "lead_source" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "lead_source_detail" text;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "lead_source" text;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "lead_source_detail" text;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_lead_source_check" CHECK ("lead_source" IS NULL OR "lead_source" IN ('inbound','outbound','referral','partner','event','other'));--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_lead_source_check" CHECK ("lead_source" IS NULL OR "lead_source" IN ('inbound','outbound','referral','partner','event','other'));
