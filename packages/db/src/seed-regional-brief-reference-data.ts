import { createDb } from "./index.js";
import { schema } from "./index.js";
import { eq } from "drizzle-orm";

const { regions, countries } = schema;

async function main() {
  const databaseUrl = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout";
  const { db } = createDb(databaseUrl);

  const [existingAmericas] = await db.select().from(regions).where(eq(regions.code, "AMERICAS"));
  const americas = existingAmericas ?? (await db.insert(regions).values({ code: "AMERICAS", name: "Americas" }).returning())[0]!;

  const [existingEmea] = await db.select().from(regions).where(eq(regions.code, "EMEA"));
  const emea = existingEmea ?? (await db.insert(regions).values({ code: "EMEA", name: "Europe, Middle East & Africa" }).returning())[0]!;

  const [existingUs] = await db.select().from(countries).where(eq(countries.isoCode, "US"));
  if (!existingUs) await db.insert(countries).values({ isoCode: "US", name: "United States", regionId: americas.id, currencyCode: "USD" });

  const [existingGb] = await db.select().from(countries).where(eq(countries.isoCode, "GB"));
  if (!existingGb) await db.insert(countries).values({ isoCode: "GB", name: "United Kingdom", regionId: emea.id, currencyCode: "GBP" });

  console.log("Seeded regions: AMERICAS, EMEA. Seeded countries: US, GB.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
