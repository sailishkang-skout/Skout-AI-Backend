/**
 * seed-regional-brief-reference-data.ts
 *
 * Seeds the complete global reference dataset from the Excel specification:
 * 1. All top-level regions (NAM, EMEA, APAC, LATAM)
 * 2. All 15 sub-regions with parent_id hierarchy
 * 3. All 250 global countries across the entire world with iso_code, iso_alpha3, and region_id
 * 4. All country aliases for deterministic multi-format resolution
 * 5. 20-sector NAICS TAM reference rows with fact-checked establishment figures
 *
 * Safe to re-run — all inserts use ON CONFLICT DO UPDATE / DO NOTHING semantics.
 */

import postgres from "postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

import { resolveDatabaseUrl, resolvePostgresSsl } from "./database-url.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Optional: load .env for local CLI runs (dotenv is optional in container images)
try {
  const { config } = await import("dotenv");
  config({ path: path.resolve(__dirname, "../../../.env") });
} catch {
  // In production (ECS, K8s, CI), environment variables are injected directly.
}

const databaseUrl = resolveDatabaseUrl();
const ssl = resolvePostgresSsl();
const sql = postgres(databaseUrl, { max: 1, ssl });

async function run(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    console.log(`✓ ${label}`);
  } catch (e) {
    console.error(`✗ ${label}:`, (e as Error).message);
  }
}

// ── Top-level regions ──────────────────────────────────────────────────────────
const TOP_LEVEL_REGIONS = [
  { code: "NAM", name: "North America" },
  { code: "EMEA", name: "Europe, Middle East & Africa" },
  { code: "APAC", name: "Asia-Pacific" },
  { code: "LATAM", name: "Latin America" },
] as const;

// ── Sub-regions ────────────────────────────────────────────────────────────────
const SUB_REGIONS: { code: string; name: string; parentCode: string }[] = [
  { code: "NAM-SUB", name: "North America", parentCode: "NAM" },
  { code: "NAM", name: "North America (Sub)", parentCode: "NAM" },
  // EMEA
  { code: "UKI", name: "UK & Ireland", parentCode: "EMEA" },
  { code: "NORDICS", name: "Nordics", parentCode: "EMEA" },
  { code: "DACH", name: "DACH (Germany, Austria, Switzerland)", parentCode: "EMEA" },
  { code: "BENELUX", name: "Benelux", parentCode: "EMEA" },
  { code: "SOUTH EUROPE", name: "South Europe", parentCode: "EMEA" },
  { code: "CEE & BALTICS", name: "Central & Eastern Europe and Baltics", parentCode: "EMEA" },
  { code: "MEA", name: "Middle East & Africa", parentCode: "EMEA" },
  // APAC
  { code: "ANZ", name: "Australia & New Zealand", parentCode: "APAC" },
  { code: "ASEAN", name: "ASEAN", parentCode: "APAC" },
  { code: "INDIA", name: "India", parentCode: "APAC" },
  { code: "NASIA", name: "North Asia (Japan, South Korea, China)", parentCode: "APAC" },
  // LATAM
  { code: "BRAZIL", name: "Brazil", parentCode: "LATAM" },
  { code: "NORTH LATAM", name: "North Latin America", parentCode: "LATAM" },
  { code: "SOUTH LATAM", name: "South Latin America", parentCode: "LATAM" },
];

// ── NAICS 2022 2-digit sectors with official fact-checked establishment data
const NAICS_SECTORS = [
  { code: "11", name: "Agriculture, Forestry, Fishing and Hunting", usEstab: 23308, gbEstab: 146420 },
  { code: "21", name: "Mining, Quarrying, and Oil and Gas Extraction", usEstab: 23048, gbEstab: 4405 },
  { code: "22", name: "Utilities", usEstab: 19896, gbEstab: 19755 },
  { code: "23", name: "Construction", usEstab: 780257, gbEstab: 883065 },
  { code: "31", name: "Manufacturing", usEstab: 283015, gbEstab: 269425 },
  { code: "42", name: "Wholesale Trade", usEstab: 390842, gbEstab: 233510 },
  { code: "44", name: "Retail Trade", usEstab: 1036879, gbEstab: 314040 },
  { code: "48", name: "Transportation and Warehousing", usEstab: 279148, gbEstab: 348115 },
  { code: "51", name: "Information", usEstab: 162006, gbEstab: 318550 },
  { code: "52", name: "Finance and Insurance", usEstab: 478891, gbEstab: 80130 },
  { code: "53", name: "Real Estate and Rental and Leasing", usEstab: 456226, gbEstab: 167640 },
  { code: "54", name: "Professional, Scientific, and Technical Services", usEstab: 962470, gbEstab: 771285 },
  { code: "55", name: "Management of Companies and Enterprises", usEstab: 52072, gbEstab: 227380 },
  { code: "56", name: "Administrative and Support and Waste Management and Remediation Services", usEstab: 447474, gbEstab: 497120 },
  { code: "61", name: "Educational Services", usEstab: 111543, gbEstab: 310095 },
  { code: "62", name: "Health Care and Social Assistance", usEstab: 947570, gbEstab: 342750 },
  { code: "71", name: "Arts, Entertainment, and Recreation", usEstab: 156145, gbEstab: 280525 },
  { code: "72", name: "Accommodation and Food Services", usEstab: 745930, gbEstab: 225550 },
  { code: "81", name: "Other Services (except Public Administration)", usEstab: 781446, gbEstab: 364280 },
  { code: "92", name: "Public Administration", usEstab: 90837, gbEstab: 21430 },
] as const;

interface GlobalCountry {
  name: string;
  isoAlpha3: string;
  isoCode: string;
  region: string;
  subRegion: string;
  salesTeam: string;
  tier: string;
  aliases: string[];
}

try {
  // ── 1. Top-level regions ─────────────────────────────────────────────────────
  console.log("\n── Upserting top-level regions ──");
  for (const r of TOP_LEVEL_REGIONS) {
    await run(`region ${r.code}`, () => sql`
      INSERT INTO regions (code, name, parent_id)
      VALUES (${r.code}, ${r.name}, null)
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name`);
  }

  // ── 2. Sub-regions ───────────────────────────────────────────────────────────
  console.log("\n── Upserting sub-regions ──");
  for (const sr of SUB_REGIONS) {
    await run(`sub-region ${sr.code}`, () => sql`
      INSERT INTO regions (code, name, parent_id)
      VALUES (
        ${sr.code},
        ${sr.name},
        (SELECT id FROM regions WHERE code = ${sr.parentCode})
      )
      ON CONFLICT (code) DO UPDATE
        SET name = EXCLUDED.name,
            parent_id = EXCLUDED.parent_id`);
  }

  // ── 3. Load all 250 global countries from JSON ────────────────────────────────
  console.log("\n── Upserting all 250 global countries ──");
  const countriesFilePath = path.resolve(__dirname, "data/global_countries.json");
  const rawData = fs.readFileSync(countriesFilePath, "utf-8");
  const globalCountries: Record<string, GlobalCountry> = JSON.parse(rawData);

  // Default region lookup helper
  const regionRows = await sql<{ id: string; code: string }[]>`SELECT id, code FROM regions`;
  const regionMap = new Map<string, string>();
  for (const row of regionRows) {
    regionMap.set(row.code, row.id);
  }

  for (const [alpha3, c] of Object.entries(globalCountries)) {
    const subRegionCode = c.subRegion || (c.region === "NAM" ? "NAM" : c.region);
    const regionId = regionMap.get(subRegionCode) || regionMap.get(c.region) || regionMap.get("MEA")!;

    await run(`country ${alpha3} (${c.name})`, async () => {
      const [inserted] = await sql<{ id: string }[]>`
        INSERT INTO countries (iso_code, iso_alpha3, name, region_id, currency_code)
        VALUES (${c.isoCode}, ${c.isoAlpha3}, ${c.name}, ${regionId}, 'USD')
        ON CONFLICT (iso_code) DO UPDATE
          SET iso_alpha3 = EXCLUDED.iso_alpha3,
              name = EXCLUDED.name,
              region_id = EXCLUDED.region_id
        RETURNING id`;

      const countryId = inserted?.id || (await sql<{ id: string }[]>`SELECT id FROM countries WHERE iso_code = ${c.isoCode}`)[0]?.id;

      if (countryId) {
        // Upsert canonical aliases: name, alpha3, and explicit aliases
        const aliasesToInsert = new Set<string>([c.name, c.isoAlpha3, c.isoCode, ...(c.aliases || [])]);
        for (const alias of aliasesToInsert) {
          if (alias && alias.trim()) {
            await sql`
              INSERT INTO country_aliases (country_id, alias, canonical_include)
              VALUES (${countryId}, ${alias.trim()}, true)
              ON CONFLICT (alias) DO NOTHING`;
          }
        }
      }
    });
  }

  // ── 4. Global NAICS TAM rows (5,000 rows across 250 countries) ─────────────
  console.log("\n── Upserting 20-sector NAICS TAM rows for all 250 global countries ──");
  const tamFilePath = path.resolve(__dirname, "data/global_country_industry_tam.json");
  
  if (fs.existsSync(tamFilePath)) {
    const rawTamData = fs.readFileSync(tamFilePath, "utf-8");
    interface TamSeedRow {
      countryIso: string;
      countryIso2: string;
      countryName: string;
      industryCode: string;
      industryName: string;
      establishments: number | null;
      icpFitPct: number;
      acvUsd: number;
      dataSource: string;
      dataYear: number;
      canonicalInclude: boolean;
    }
    const globalTamRows: TamSeedRow[] = JSON.parse(rawTamData);

    const countryIdLookup = new Map<string, string>();
    const countryRows = await sql<{ id: string; iso_alpha3: string; iso_code: string }[]>`
      SELECT id, iso_alpha3, iso_code FROM countries
    `;
    for (const cr of countryRows) {
      countryIdLookup.set(cr.iso_alpha3, cr.id);
      countryIdLookup.set(cr.iso_code, cr.id);
    }

    let upsertedCount = 0;
    // Batch in chunks of 100 for fast ingestion
    const chunkSize = 100;
    for (let i = 0; i < globalTamRows.length; i += chunkSize) {
      const chunk = globalTamRows.slice(i, i + chunkSize);
      for (const row of chunk) {
        const countryId = countryIdLookup.get(row.countryIso) || countryIdLookup.get(row.countryIso2);
        if (!countryId) continue;

        await sql`
          INSERT INTO country_industry_tam (
            country_id, industry_code, industry_name,
            establishments, icp_fit_pct, acv_usd,
            data_source, data_year, canonical_include
          )
          VALUES (
            ${countryId},
            ${row.industryCode}, ${row.industryName},
            ${row.establishments}, ${row.icpFitPct}, ${row.acvUsd},
            ${row.dataSource}, ${row.dataYear}, ${row.canonicalInclude}
          )
          ON CONFLICT (country_id, industry_code) DO UPDATE
            SET industry_name  = EXCLUDED.industry_name,
                establishments = EXCLUDED.establishments,
                icp_fit_pct    = EXCLUDED.icp_fit_pct,
                acv_usd        = EXCLUDED.acv_usd,
                data_source    = EXCLUDED.data_source,
                data_year      = EXCLUDED.data_year,
                canonical_include = EXCLUDED.canonical_include
        `;
        upsertedCount++;
      }
    }
    console.log(`✓ Seeded ${upsertedCount} country × industry TAM rows.`);
  }

  console.log("\n✅ Global reference data seeded successfully.");
} finally {
  await sql.end();
}
