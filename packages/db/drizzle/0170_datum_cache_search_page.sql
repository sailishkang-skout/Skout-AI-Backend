-- PAPI-051: the datum cache also holds public API search pages, for the "cached repeat costs 0" rule
-- (PRD §8.1). Search pages are kept 24 hours (purged by the maintenance job).
ALTER TABLE "api_datum_cache" DROP CONSTRAINT IF EXISTS "api_datum_cache_type_check";
--> statement-breakpoint
ALTER TABLE "api_datum_cache" ADD CONSTRAINT "api_datum_cache_type_check"
  CHECK ("datum_type" IN ('email', 'phone', 'person', 'company', 'company_jobs', 'search_page'));
