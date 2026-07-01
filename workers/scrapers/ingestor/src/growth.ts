import { and, desc, eq, lte } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { CompanyCandidate } from "@skout/scraper-contracts";
import type { ProspectDocument } from "@skout/opensearch";

const GROWTH_WINDOWS_MONTHS = [3, 6, 12] as const;

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^www\./, "");
}

export function growthPct(current: number, past: number): number | undefined {
  if (!past || past <= 0) return undefined;
  return Math.round(((current - past) / past) * 1000) / 10;
}

export async function recordSnapshot(db: Db, company: CompanyCandidate): Promise<void> {
  try {
    await db.insert(schema.companySnapshots).values({
      domain: normalizeDomain(company.domain),
      employeeCount: company.employeeCount ?? null,
      openJobs: company.openJobs ?? null,
      annualRevenue: company.annualRevenue ?? null,
      scrapedAt: new Date(company.scrapedAt),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/company_snapshots|relation .* does not exist/i.test(message)) {
      console.warn(
        "[ingestor] company_snapshots table missing — run migration 0007. Skipping snapshot insert."
      );
      return;
    }
    throw err;
  }
}

export async function computeHeadcountGrowthAtMonths(
  db: Db,
  domain: string,
  currentEmployees?: number,
  months = 3
): Promise<number | undefined> {
  if (!currentEmployees || currentEmployees <= 0) return undefined;

  const cutoff = new Date(Date.now() - months * 30 * 86_400_000);
  let past: { employeeCount: number | null } | undefined;
  try {
    [past] = await db
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/company_snapshots|relation .* does not exist/i.test(message)) return undefined;
    throw err;
  }

  if (!past?.employeeCount) return undefined;
  return growthPct(currentEmployees, past.employeeCount);
}

/** @deprecated use computeHeadcountGrowthAtMonths with months=3 */
export async function computeHeadcountGrowth(
  db: Db,
  domain: string,
  currentEmployees?: number
): Promise<number | undefined> {
  return computeHeadcountGrowthAtMonths(db, domain, currentEmployees, 3);
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
      const growthByWindow: Record<string, number> = {};
      for (const months of GROWTH_WINDOWS_MONTHS) {
        const pct = await computeHeadcountGrowthAtMonths(db, doc.companyDomain, doc.employeeCount, months);
        if (pct != null) growthByWindow[`${months}m`] = pct;
      }
      const headcountGrowth = growthByWindow["3m"];
      const signals = [...(doc.signals ?? [])];
      for (const [window, pct] of Object.entries(growthByWindow)) {
        signals.push({
          type: "headcount_growth",
          observedAt: new Date().toISOString(),
          detail: `${window}: ${pct}%`,
        });
      }
      return {
        ...doc,
        headcountGrowth,
        signals: signals.length ? signals : doc.signals,
      };
    })
  );
}
