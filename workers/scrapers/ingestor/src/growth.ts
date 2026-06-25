import { and, desc, eq, lte } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { CompanyCandidate } from "@skout/scraper-contracts";
import type { ProspectDocument } from "@skout/opensearch";

const GROWTH_LOOKBACK_DAYS = Number(process.env.GROWTH_LOOKBACK_DAYS ?? 90);

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^www\./, "");
}

export function growthPct(current: number, past: number): number | undefined {
  if (!past || past <= 0) return undefined;
  return Math.round(((current - past) / past) * 1000) / 10;
}

export async function recordSnapshot(db: Db, company: CompanyCandidate): Promise<void> {
  await db.insert(schema.companySnapshots).values({
    domain: normalizeDomain(company.domain),
    employeeCount: company.employeeCount ?? null,
    openJobs: company.openJobs ?? null,
    annualRevenue: company.annualRevenue ?? null,
    scrapedAt: new Date(company.scrapedAt),
  });
}

export async function computeHeadcountGrowth(
  db: Db,
  domain: string,
  currentEmployees?: number
): Promise<number | undefined> {
  if (!currentEmployees || currentEmployees <= 0) return undefined;

  const cutoff = new Date(Date.now() - GROWTH_LOOKBACK_DAYS * 86_400_000);
  const [past] = await db
    .select({ employeeCount: schema.companySnapshots.employeeCount })
    .from(schema.companySnapshots)
    .where(
      and(
        eq(schema.companySnapshots.domain, normalizeDomain(domain)),
        lte(schema.companySnapshots.scrapedAt, cutoff)
      )
    )
    .orderBy(desc(schema.companySnapshots.scrapedAt))
    .limit(1);

  if (!past?.employeeCount) return undefined;
  return growthPct(currentEmployees, past.employeeCount);
}

/** Upsert snapshots and attach growth metrics to company prospect docs. */
export async function enrichDocsWithGrowth(
  db: Db,
  records: unknown[],
  docs: ProspectDocument[]
): Promise<ProspectDocument[]> {
  const companies = records.filter(
    (r) => typeof r === "object" && r !== null && "domain" in r && !("companyDomain" in r)
  ) as CompanyCandidate[];

  for (const company of companies) {
    await recordSnapshot(db, company);
  }

  return Promise.all(
    docs.map(async (doc) => {
      if (!doc.employeeCount) return doc;
      const headcountGrowth = await computeHeadcountGrowth(db, doc.companyDomain, doc.employeeCount);
      return headcountGrowth != null ? { ...doc, headcountGrowth } : doc;
    })
  );
}
