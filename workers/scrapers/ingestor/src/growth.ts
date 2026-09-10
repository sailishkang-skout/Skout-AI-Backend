import { and, desc, eq, lte } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { CompanyCandidate, Signal } from "@skout/scraper-contracts";
import type { ProspectDocument } from "@skout/opensearch";
import { generateCompanyId } from "@skout/shared";
import { recordSignals } from "./signals-store.js";

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
      techStack: company.techStack ?? null,
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

/** Most recent snapshot's tech stack for a domain, prior to the snapshot about to be recorded. */
async function getPreviousTechStack(
  db: Db,
  domain: string
): Promise<{ category: string; technology: string }[] | undefined> {
  try {
    const [prev] = await db
      .select({ techStack: schema.companySnapshots.techStack })
      .from(schema.companySnapshots)
      .where(eq(schema.companySnapshots.domain, normalizeDomain(domain)))
      .orderBy(desc(schema.companySnapshots.scrapedAt))
      .limit(1);
    return (prev?.techStack as { category: string; technology: string }[] | null) ?? undefined;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/company_snapshots|relation .* does not exist/i.test(message)) return undefined;
    throw err;
  }
}

/** R11.1 — tool-level delta between two tech-stack snapshots, keyed by technology name. */
export function computeTechStackDelta(
  previous: { technology: string }[] | undefined,
  current: { technology: string }[] | undefined
): { added: string[]; dropped: string[] } {
  if (!previous || previous.length === 0) return { added: [], dropped: [] };
  const prevSet = new Set(previous.map((t) => t.technology));
  const currentSet = new Set((current ?? []).map((t) => t.technology));
  return {
    added: [...currentSet].filter((t) => !prevSet.has(t)),
    dropped: [...prevSet].filter((t) => !currentSet.has(t)),
  };
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

  // R11.1 — per-company tech-stack delta vs. the prior snapshot, merged into that company's
  // prospect docs below so it's indexed into `doc.signals[]` the same way headcount_growth is,
  // and therefore usable as a search filter (existing `signals.type` nested-field filters).
  const techDeltaSignalsByCompanyId = new Map<string, Signal[]>();

  for (const company of companies) {
    const previousTechStack = await getPreviousTechStack(db, company.domain);
    await recordSnapshot(db, company);

    const companyId = generateCompanyId(company.domain);
    const { added, dropped } = computeTechStackDelta(previousTechStack, company.techStack);
    const techDeltaSignals: Signal[] = [
      ...added.map((technology) => ({
        type: "tech_adopted" as const,
        observedAt: new Date(company.scrapedAt).toISOString(),
        detail: technology,
        source: "recrawl",
      })),
      ...dropped.map((technology) => ({
        type: "tech_dropped" as const,
        observedAt: new Date(company.scrapedAt).toISOString(),
        detail: technology,
        source: "recrawl",
      })),
    ];
    if (techDeltaSignals.length) techDeltaSignalsByCompanyId.set(companyId, techDeltaSignals);

    await recordSignals(db, companyId, [...(company.signals ?? []), ...techDeltaSignals]);
  }

  // Guard against persisting the same company's headcount-growth signal once per
  // person-level doc — docs.map below iterates every prospect doc for a company.
  const persistedGrowthEntityIds = new Set<string>();

  return Promise.all(
    docs.map(async (doc) => {
      const techDeltaSignals = techDeltaSignalsByCompanyId.get(doc.companyId) ?? [];
      if (!doc.employeeCount) {
        return techDeltaSignals.length
          ? { ...doc, signals: [...(doc.signals ?? []), ...techDeltaSignals] }
          : doc;
      }
      const growthByWindow: Record<string, number> = {};
      for (const months of GROWTH_WINDOWS_MONTHS) {
        const pct = await computeHeadcountGrowthAtMonths(db, doc.companyDomain, doc.employeeCount, months);
        if (pct != null) growthByWindow[`${months}m`] = pct;
      }
      const headcountGrowth = growthByWindow["3m"];
      const signals = [...(doc.signals ?? []), ...techDeltaSignals];
      const newSignals: Signal[] = [];
      for (const [window, pct] of Object.entries(growthByWindow)) {
        const signal: Signal = {
          type: "headcount_growth",
          observedAt: new Date().toISOString(),
          detail: `${window}: ${pct}%`,
        };
        signals.push(signal);
        newSignals.push(signal);
      }
      if (newSignals.length && !persistedGrowthEntityIds.has(doc.companyId)) {
        persistedGrowthEntityIds.add(doc.companyId);
        await recordSignals(db, doc.companyId, newSignals);
      }
      return {
        ...doc,
        headcountGrowth,
        signals: signals.length ? signals : doc.signals,
      };
    })
  );
}
