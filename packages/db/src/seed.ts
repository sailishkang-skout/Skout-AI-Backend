import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { createDb } from "./client.js";
import { resolveDatabaseUrl } from "./database-url.js";
import { creditBalances } from "./schema/credits.js";
import { companies, contacts } from "./schema/crm.js";
import { workspaceIcp } from "./schema/icp.js";
import { lists } from "./schema/prospects.js";
import { workspaces } from "./schema/workspaces.js";
import { regions, countries, countryAliases } from "./schema/regional-brief.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Optional: load .env for local `pnpm db:seed` (dotenv is dev-only, not in ECS image).
try {
  const { config } = await import("dotenv");
  config({ path: path.resolve(__dirname, "../../../.env") });
} catch {
  // ECS/task inject DATABASE_HOST + DATABASE_PASSWORD directly.
}

const databaseUrl = resolveDatabaseUrl();

const DEMO_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

const { db, sql } = createDb(databaseUrl);

try {
  const [existing] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, DEMO_WORKSPACE_ID))
    .limit(1);

  if (!existing) {
    await db.insert(workspaces).values({
      id: DEMO_WORKSPACE_ID,
      name: "Demo Workspace",
      slug: "demo",
    });
    console.log("Created demo workspace");
  } else {
    console.log("Demo workspace already exists");
  }

  await db
    .insert(creditBalances)
    .values({ workspaceId: DEMO_WORKSPACE_ID, balance: 500 })
    .onConflictDoUpdate({
      target: creditBalances.workspaceId,
      set: { balance: 500 },
    });
  console.log("Seeded 500 credits");

  await db
    .insert(workspaceIcp)
    .values({
      workspaceId: DEMO_WORKSPACE_ID,
      config: {
        industries: ["Software & SaaS"],
        countries: ["US"],
        seniorities: ["vp", "director"],
        minEmployees: 10,
      },
      version: 1,
    })
    .onConflictDoUpdate({
      target: workspaceIcp.workspaceId,
      set: {
        config: {
          industries: ["Software & SaaS"],
          countries: ["US"],
          seniorities: ["vp", "director"],
          minEmployees: 10,
        },
        version: 1,
        updatedAt: new Date(),
      },
    });
  console.log("Seeded demo ICP");

  const [demoList] = await db
    .select({ id: lists.id })
    .from(lists)
    .where(eq(lists.workspaceId, DEMO_WORKSPACE_ID))
    .limit(1);

  if (!demoList) {
    await db.insert(lists).values({
      workspaceId: DEMO_WORKSPACE_ID,
      name: "My First List",
    });
    console.log("Created demo list");
  }





  // ── Global reference regions & 250 countries for TAM & Regional Intelligence ──
  try {
    const countriesFilePath = path.resolve(__dirname, "data/global_countries.json");
    if (fs.existsSync(countriesFilePath)) {
      const topLevelRegions = [
        { code: "NAM", name: "North America" },
        { code: "EMEA", name: "Europe, Middle East & Africa" },
        { code: "APAC", name: "Asia-Pacific" },
        { code: "LATAM", name: "Latin America" },
      ];
      for (const r of topLevelRegions) {
        await sql`
          INSERT INTO regions (code, name, parent_id)
          VALUES (${r.code}, ${r.name}, null)
          ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name`;
      }

      const subRegions = [
        { code: "NAM-SUB", name: "North America", parentCode: "NAM" },
        { code: "NAM", name: "North America (Sub)", parentCode: "NAM" },
        { code: "UKI", name: "UK & Ireland", parentCode: "EMEA" },
        { code: "NORDICS", name: "Nordics", parentCode: "EMEA" },
        { code: "DACH", name: "DACH (Germany, Austria, Switzerland)", parentCode: "EMEA" },
        { code: "BENELUX", name: "Benelux", parentCode: "EMEA" },
        { code: "SOUTH EUROPE", name: "South Europe", parentCode: "EMEA" },
        { code: "CEE & BALTICS", name: "Central & Eastern Europe and Baltics", parentCode: "EMEA" },
        { code: "MEA", name: "Middle East & Africa", parentCode: "EMEA" },
        { code: "ANZ", name: "Australia & New Zealand", parentCode: "APAC" },
        { code: "ASEAN", name: "ASEAN", parentCode: "APAC" },
        { code: "INDIA", name: "India", parentCode: "APAC" },
        { code: "NASIA", name: "North Asia (Japan, South Korea, China)", parentCode: "APAC" },
        { code: "BRAZIL", name: "Brazil", parentCode: "LATAM" },
        { code: "NORTH LATAM", name: "North Latin America", parentCode: "LATAM" },
        { code: "SOUTH LATAM", name: "South Latin America", parentCode: "LATAM" },
      ];
      for (const sr of subRegions) {
        await sql`
          INSERT INTO regions (code, name, parent_id)
          VALUES (
            ${sr.code},
            ${sr.name},
            (SELECT id FROM regions WHERE code = ${sr.parentCode})
          )
          ON CONFLICT (code) DO UPDATE
            SET name = EXCLUDED.name,
                parent_id = EXCLUDED.parent_id`;
      }

      const rawData = fs.readFileSync(countriesFilePath, "utf-8");
      const globalCountries = JSON.parse(rawData);
      const regionRows = await sql<{ id: string; code: string }[]>`SELECT id, code FROM regions`;
      const regionMap = new Map<string, string>();
      for (const row of regionRows) {
        regionMap.set(row.code, row.id);
      }

      for (const [alpha3, c] of Object.entries(globalCountries as Record<string, any>)) {
        const subRegionCode = c.subRegion || (c.region === "NAM" ? "NAM" : c.region);
        const regionId = regionMap.get(subRegionCode) || regionMap.get(c.region) || regionMap.get("MEA")!;

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
      }
      console.log("Seeded all 250 global countries and regions");
    }
  } catch (err) {
    console.warn("Could not seed global reference countries:", (err as Error).message);
  }

  console.log("Seed complete");
} finally {
  await sql.end();
}