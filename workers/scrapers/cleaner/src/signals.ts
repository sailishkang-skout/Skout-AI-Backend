import type { CompanyCandidate, Signal } from "@skout/scraper-contracts";

/** Derive typed buying/hiring signals from company fields (strategy §3.3 / E5). */
export function collectSignals(company: Partial<CompanyCandidate>): Signal[] {
  const now = new Date().toISOString();
  const signals: Signal[] = [];

  if (company.isHiring || (company.openJobs ?? 0) > 0) {
    signals.push({
      type: "recent_hiring",
      observedAt: now,
      detail: company.openJobs ? `${company.openJobs} open roles` : "hiring detected",
      source: company.source,
    });
  }
  if (company.funding?.lastRoundDate) {
    signals.push({
      type: "recent_funding",
      observedAt: company.funding.lastRoundDate,
      detail: company.funding.lastRound,
      source: company.source,
    });
  }
  if (company.techStack?.length) {
    signals.push({
      type: "tech_adoption",
      observedAt: now,
      detail: company.techStack.map((t) => t.technology).join(", "),
      source: "wappalyzer",
    });
  }
  if (company.isPublic) {
    signals.push({
      type: "recent_funding",
      observedAt: now,
      detail: "public company",
      source: "sec-edgar",
    });
  }

  return [...(company.signals ?? []), ...signals];
}
