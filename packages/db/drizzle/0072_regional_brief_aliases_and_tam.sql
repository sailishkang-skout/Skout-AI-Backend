-- 0069 — Regional Brief alignment: sub-region hierarchy, alias table, iso_alpha3, country_industry_tam
-- All changes are additive (IF NOT EXISTS / nullable columns). No data is deleted.

-- 1. Add parent_id self-reference to regions (enables sub-region hierarchy)
ALTER TABLE "regions"
  ADD COLUMN IF NOT EXISTS "parent_id" uuid REFERENCES "public"."regions"("id") ON DELETE restrict;
--> statement-breakpoint

-- 2. Add iso_alpha3 to countries (nullable first so existing rows don't fail)
ALTER TABLE "countries"
  ADD COLUMN IF NOT EXISTS "iso_alpha3" text;
--> statement-breakpoint

-- 3. Back-fill iso_alpha3 for the two pilot countries seeded by seed-regional-brief.ts
UPDATE "countries" SET "iso_alpha3" = 'USA' WHERE "iso_code" = 'US' AND "iso_alpha3" IS NULL;
UPDATE "countries" SET "iso_alpha3" = 'GBR' WHERE "iso_code" = 'GB' AND "iso_alpha3" IS NULL;
--> statement-breakpoint

-- 4. Now add the unique constraint (only safe after back-fill)
DO $$ BEGIN
  ALTER TABLE "countries" ADD CONSTRAINT "countries_iso_alpha3_unique" UNIQUE ("iso_alpha3");
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

-- 5. Create country_aliases lookup table
CREATE TABLE IF NOT EXISTS "country_aliases" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "country_id"        uuid NOT NULL REFERENCES "public"."countries"("id") ON DELETE cascade,
  "alias"             text NOT NULL,
  "canonical_include" boolean NOT NULL DEFAULT true,
  "created_at"        timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "country_aliases_alias_unique" UNIQUE ("alias")
);
--> statement-breakpoint

-- 6. Create country_industry_tam table
CREATE TABLE IF NOT EXISTS "country_industry_tam" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "country_id"         uuid NOT NULL REFERENCES "public"."countries"("id") ON DELETE cascade,
  "industry_code"      text NOT NULL,
  "industry_name"      text NOT NULL,
  "establishments"     integer,
  "icp_fit_pct"        numeric(7,5) NOT NULL DEFAULT 0.10,
  "icp_fit_override"   numeric(7,5),
  "acv_usd"            numeric(14,2) NOT NULL DEFAULT 25000.00,
  "acv_override_usd"   numeric(14,2),
  "data_source"        text,
  "data_year"          integer,
  "canonical_include"  boolean NOT NULL DEFAULT true,
  "created_at"         timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"         timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "country_industry_tam_country_industry_unique" UNIQUE ("country_id", "industry_code")
);
--> statement-breakpoint

-- 7. Migrate existing scope keys from country:{uuid}:category → country:{iso_alpha3}:category
-- This updates any existing regional_brief_slots rows seeded before this migration.
UPDATE "regional_brief_slots" rbs
SET "scope_key" = regexp_replace(
  rbs."scope_key",
  '^country:([0-9a-f-]{36}):',
  'country:' || c."iso_alpha3" || ':',
  'i'
)
FROM "countries" c
WHERE rbs."scope_key" ~ '^country:[0-9a-f-]{36}:'
  AND rbs."country_id" = c."id"
  AND c."iso_alpha3" IS NOT NULL;
--> statement-breakpoint

-- 8. Similarly migrate tenant/outcome_learning scope keys that include country UUID
UPDATE "regional_brief_slots" rbs
SET "scope_key" = 'tenant:' ||
  split_part(rbs."scope_key", ':', 2) || ':' ||
  c."iso_alpha3" || ':' ||
  split_part(rbs."scope_key", ':', 4)
FROM "countries" c
WHERE rbs."scope_key" LIKE 'tenant:%'
  AND rbs."country_id" = c."id"
  AND c."iso_alpha3" IS NOT NULL
  AND rbs."scope_key" ~ '^tenant:[^:]+:[0-9a-f-]{36}:';
--> statement-breakpoint

UPDATE "regional_brief_slots" rbs
SET "scope_key" = 'outcome:' ||
  split_part(rbs."scope_key", ':', 2) || ':' ||
  c."iso_alpha3" || ':' ||
  split_part(rbs."scope_key", ':', 4)
FROM "countries" c
WHERE rbs."scope_key" LIKE 'outcome:%'
  AND rbs."country_id" = c."id"
  AND c."iso_alpha3" IS NOT NULL
  AND rbs."scope_key" ~ '^outcome:[^:]+:[0-9a-f-]{36}:';
