-- PAPI-062: webhook endpoints created through the public API are managed only there (and the app's
-- own endpoints are invisible to API keys).
ALTER TABLE "webhook_endpoints" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'app' NOT NULL;
--> statement-breakpoint
ALTER TABLE "webhook_endpoints" DROP CONSTRAINT IF EXISTS "webhook_endpoints_source_check";
--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_source_check" CHECK ("source" IN ('app', 'public_api'));
