import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

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

/**
 * Fact-checked online government statistical data:
 * - US: U.S. Census Bureau Statistics of U.S. Businesses (SUSB) 2021 & 2022 Census of Governments
 * - UK: UK Department for Business and Trade (DBT) Business Population Estimates (BPE) 2023 & ONS
 */
const REAL_TAM_DATA = [
  // ── United States (US / USA) ───────────────────────────────────────────────
  {
    countryIso: "US",
    industryCode: "11",
    industryName: "Agriculture, Forestry, Fishing and Hunting",
    establishments: 23308,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "US Census Bureau Statistics of U.S. Businesses (SUSB) 2021",
    dataYear: 2021,
  },
  {
    countryIso: "US",
    industryCode: "21",
    industryName: "Mining, Quarrying, and Oil and Gas Extraction",
    establishments: 23048,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "US Census Bureau Statistics of U.S. Businesses (SUSB) 2021",
    dataYear: 2021,
  },
  {
    countryIso: "US",
    industryCode: "22",
    industryName: "Utilities",
    establishments: 19896,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "US Census Bureau Statistics of U.S. Businesses (SUSB) 2021",
    dataYear: 2021,
  },
  {
    countryIso: "US",
    industryCode: "23",
    industryName: "Construction",
    establishments: 780257,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "US Census Bureau Statistics of U.S. Businesses (SUSB) 2021",
    dataYear: 2021,
  },
  {
    countryIso: "US",
    industryCode: "31",
    industryName: "Manufacturing",
    establishments: 283015,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "US Census Bureau Statistics of U.S. Businesses (SUSB) 2021",
    dataYear: 2021,
  },
  {
    countryIso: "US",
    industryCode: "42",
    industryName: "Wholesale Trade",
    establishments: 390842,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "US Census Bureau Statistics of U.S. Businesses (SUSB) 2021",
    dataYear: 2021,
  },
  {
    countryIso: "US",
    industryCode: "44",
    industryName: "Retail Trade",
    establishments: 1036879,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "US Census Bureau Statistics of U.S. Businesses (SUSB) 2021",
    dataYear: 2021,
  },
  {
    countryIso: "US",
    industryCode: "48",
    industryName: "Transportation and Warehousing",
    establishments: 279148,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "US Census Bureau Statistics of U.S. Businesses (SUSB) 2021",
    dataYear: 2021,
  },
  {
    countryIso: "US",
    industryCode: "51",
    industryName: "Information",
    establishments: 162006,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "US Census Bureau Statistics of U.S. Businesses (SUSB) 2021",
    dataYear: 2021,
  },
  {
    countryIso: "US",
    industryCode: "52",
    industryName: "Finance and Insurance",
    establishments: 478891,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "US Census Bureau Statistics of U.S. Businesses (SUSB) 2021",
    dataYear: 2021,
  },
  {
    countryIso: "US",
    industryCode: "53",
    industryName: "Real Estate and Rental and Leasing",
    establishments: 456226,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "US Census Bureau Statistics of U.S. Businesses (SUSB) 2021",
    dataYear: 2021,
  },
  {
    countryIso: "US",
    industryCode: "54",
    industryName: "Professional, Scientific, and Technical Services",
    establishments: 962470,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "US Census Bureau Statistics of U.S. Businesses (SUSB) 2021",
    dataYear: 2021,
  },
  {
    countryIso: "US",
    industryCode: "55",
    industryName: "Management of Companies and Enterprises",
    establishments: 52072,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "US Census Bureau Statistics of U.S. Businesses (SUSB) 2021",
    dataYear: 2021,
  },
  {
    countryIso: "US",
    industryCode: "56",
    industryName: "Administrative and Support and Waste Management and Remediation Services",
    establishments: 447474,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "US Census Bureau Statistics of U.S. Businesses (SUSB) 2021",
    dataYear: 2021,
  },
  {
    countryIso: "US",
    industryCode: "61",
    industryName: "Educational Services",
    establishments: 111543,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "US Census Bureau Statistics of U.S. Businesses (SUSB) 2021",
    dataYear: 2021,
  },
  {
    countryIso: "US",
    industryCode: "62",
    industryName: "Health Care and Social Assistance",
    establishments: 947570,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "US Census Bureau Statistics of U.S. Businesses (SUSB) 2021",
    dataYear: 2021,
  },
  {
    countryIso: "US",
    industryCode: "71",
    industryName: "Arts, Entertainment, and Recreation",
    establishments: 156145,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "US Census Bureau Statistics of U.S. Businesses (SUSB) 2021",
    dataYear: 2021,
  },
  {
    countryIso: "US",
    industryCode: "72",
    industryName: "Accommodation and Food Services",
    establishments: 745930,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "US Census Bureau Statistics of U.S. Businesses (SUSB) 2021",
    dataYear: 2021,
  },
  {
    countryIso: "US",
    industryCode: "81",
    industryName: "Other Services (except Public Administration)",
    establishments: 781446,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "US Census Bureau Statistics of U.S. Businesses (SUSB) 2021",
    dataYear: 2021,
  },
  {
    countryIso: "US",
    industryCode: "92",
    industryName: "Public Administration",
    establishments: 90837,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "US Census Bureau 2022 Census of Governments",
    dataYear: 2022,
  },

  // ── United Kingdom (GB / GBR) ─────────────────────────────────────────────
  {
    countryIso: "GB",
    industryCode: "11",
    industryName: "Agriculture, Forestry, Fishing and Hunting",
    establishments: 146420,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "UK Department for Business and Trade Business Population Estimates (BPE) 2023",
    dataYear: 2023,
  },
  {
    countryIso: "GB",
    industryCode: "21",
    industryName: "Mining, Quarrying, and Oil and Gas Extraction",
    establishments: 4405,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "UK Department for Business and Trade Business Population Estimates (BPE) 2023",
    dataYear: 2023,
  },
  {
    countryIso: "GB",
    industryCode: "22",
    industryName: "Utilities",
    establishments: 19755,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "UK Department for Business and Trade Business Population Estimates (BPE) 2023",
    dataYear: 2023,
  },
  {
    countryIso: "GB",
    industryCode: "23",
    industryName: "Construction",
    establishments: 883065,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "UK Department for Business and Trade Business Population Estimates (BPE) 2023",
    dataYear: 2023,
  },
  {
    countryIso: "GB",
    industryCode: "31",
    industryName: "Manufacturing",
    establishments: 269425,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "UK Department for Business and Trade Business Population Estimates (BPE) 2023",
    dataYear: 2023,
  },
  {
    countryIso: "GB",
    industryCode: "42",
    industryName: "Wholesale Trade",
    establishments: 233510,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "UK Department for Business and Trade Business Population Estimates (BPE) 2023",
    dataYear: 2023,
  },
  {
    countryIso: "GB",
    industryCode: "44",
    industryName: "Retail Trade",
    establishments: 314040,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "UK Department for Business and Trade Business Population Estimates (BPE) 2023",
    dataYear: 2023,
  },
  {
    countryIso: "GB",
    industryCode: "48",
    industryName: "Transportation and Warehousing",
    establishments: 348115,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "UK Department for Business and Trade Business Population Estimates (BPE) 2023",
    dataYear: 2023,
  },
  {
    countryIso: "GB",
    industryCode: "51",
    industryName: "Information",
    establishments: 318550,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "UK Department for Business and Trade Business Population Estimates (BPE) 2023",
    dataYear: 2023,
  },
  {
    countryIso: "GB",
    industryCode: "52",
    industryName: "Finance and Insurance",
    establishments: 80130,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "UK Department for Business and Trade Business Population Estimates (BPE) 2023",
    dataYear: 2023,
  },
  {
    countryIso: "GB",
    industryCode: "53",
    industryName: "Real Estate and Rental and Leasing",
    establishments: 167640,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "UK Department for Business and Trade Business Population Estimates (BPE) 2023",
    dataYear: 2023,
  },
  {
    countryIso: "GB",
    industryCode: "54",
    industryName: "Professional, Scientific, and Technical Services",
    establishments: 771285,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "UK Department for Business and Trade Business Population Estimates (BPE) 2023",
    dataYear: 2023,
  },
  {
    countryIso: "GB",
    industryCode: "55",
    industryName: "Management of Companies and Enterprises",
    establishments: 227380,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "UK Department for Business and Trade Business Population Estimates (BPE) 2023",
    dataYear: 2023,
  },
  {
    countryIso: "GB",
    industryCode: "56",
    industryName: "Administrative and Support and Waste Management and Remediation Services",
    establishments: 497120,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "UK Department for Business and Trade Business Population Estimates (BPE) 2023",
    dataYear: 2023,
  },
  {
    countryIso: "GB",
    industryCode: "61",
    industryName: "Educational Services",
    establishments: 310095,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "UK Department for Business and Trade Business Population Estimates (BPE) 2023",
    dataYear: 2023,
  },
  {
    countryIso: "GB",
    industryCode: "62",
    industryName: "Health Care and Social Assistance",
    establishments: 342750,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "UK Department for Business and Trade Business Population Estimates (BPE) 2023",
    dataYear: 2023,
  },
  {
    countryIso: "GB",
    industryCode: "71",
    industryName: "Arts, Entertainment, and Recreation",
    establishments: 280525,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "UK Department for Business and Trade Business Population Estimates (BPE) 2023",
    dataYear: 2023,
  },
  {
    countryIso: "GB",
    industryCode: "72",
    industryName: "Accommodation and Food Services",
    establishments: 225550,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "UK Department for Business and Trade Business Population Estimates (BPE) 2023",
    dataYear: 2023,
  },
  {
    countryIso: "GB",
    industryCode: "81",
    industryName: "Other Services (except Public Administration)",
    establishments: 364280,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "UK Department for Business and Trade Business Population Estimates (BPE) 2023",
    dataYear: 2023,
  },
  {
    countryIso: "GB",
    industryCode: "92",
    industryName: "Public Administration",
    establishments: 21430,
    icpFitPct: 0.10,
    acvUsd: 25000,
    canonicalInclude: true,
    dataSource: "UK Office for National Statistics (ONS) Public Sector Statistics 2023",
    dataYear: 2023,
  },
];

async function seedRealTam() {
  console.log("── Loading Real TAM Data into Database ──");

  const countryRows = await sql<{ id: string; iso_code: string; iso_alpha3: string }[]>`
    SELECT id, iso_code, iso_alpha3 FROM countries WHERE iso_code IN ('US', 'GB')
  `;
  const countryMap = new Map(countryRows.map(c => [c.iso_code, c]));

  let insertedCount = 0;
  for (const row of REAL_TAM_DATA) {
    const c = countryMap.get(row.countryIso);
    if (!c) {
      console.warn(`Country not found for iso: ${row.countryIso}`);
      continue;
    }

    await sql`
      INSERT INTO country_industry_tam (
        country_id,
        industry_code,
        industry_name,
        establishments,
        icp_fit_pct,
        acv_usd,
        canonical_include,
        data_source,
        data_year
      )
      VALUES (
        ${c.id},
        ${row.industryCode},
        ${row.industryName},
        ${row.establishments},
        ${row.icpFitPct.toString()},
        ${row.acvUsd.toString()},
        ${row.canonicalInclude},
        ${row.dataSource},
        ${row.dataYear}
      )
      ON CONFLICT (country_id, industry_code)
      DO UPDATE SET
        industry_name = EXCLUDED.industry_name,
        establishments = EXCLUDED.establishments,
        icp_fit_pct = EXCLUDED.icp_fit_pct,
        acv_usd = EXCLUDED.acv_usd,
        canonical_include = EXCLUDED.canonical_include,
        data_source = EXCLUDED.data_source,
        data_year = EXCLUDED.data_year,
        updated_at = NOW()
    `;

    const targetAccounts = Math.round(row.establishments * row.icpFitPct);
    const revTam = Math.round(targetAccounts * row.acvUsd);
    console.log(`✓ [${row.countryIso}] NAICS ${row.industryCode} (${row.industryName}): ${row.establishments.toLocaleString()} estabs → ${targetAccounts.toLocaleString()} accounts → $${revTam.toLocaleString()} USD (${row.dataSource.slice(0, 35)}...)`);
    insertedCount++;
  }

  console.log(`\n✅ Successfully loaded ${insertedCount} fact-checked TAM rows.`);
}

try {
  await seedRealTam();
} finally {
  await sql.end();
}
