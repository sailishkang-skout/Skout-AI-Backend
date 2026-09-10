import { createHash } from "node:crypto";
import { generateCompanyId, normalizeDomain } from "@skout/shared";
import type { CompanyCandidate, ProspectCandidate } from "@skout/scraper-contracts";
import type { ProspectDocument } from "@skout/opensearch";

export function companyId(domain: string): string {
  return generateCompanyId(normalizeDomain(domain));
}

export function prospectId(domain: string, email?: string, fullName?: string): string {
  const d = normalizeDomain(domain);
  const key = email
    ? `${d}:${createHash("sha256").update(email.toLowerCase()).digest("hex")}`
    : `${d}:${(fullName ?? "").toLowerCase()}`;
  return createHash("sha256").update(key).digest("hex");
}

function foundedYearFromCandidate(c: CompanyCandidate): number | undefined {
  if (c.foundedDate) {
    const year = Number(c.foundedDate.slice(0, 4));
    if (year > 1800 && year < 2100) return year;
  }
  return undefined;
}

export function companyToProspectDoc(c: CompanyCandidate): ProspectDocument {
  const domain = normalizeDomain(c.domain);
  const pid = generateCompanyId(domain);
  return {
    prospectId: pid,
    companyId: companyId(domain),
    companyDomain: domain,
    companyName: c.companyName,
    industry: c.industry,
    subIndustry: c.subIndustry,
    country: c.hqCountry,
    state: c.hqState,
    city: c.hqCity,
    employeeCount: c.employeeCount,
    employeeBucket: c.employeeBucket,
    companyStage: c.companyStage,
    annualRevenue: c.annualRevenue,
    lastFundingRound: c.funding?.lastRound,
    lastFundingDate: c.funding?.lastRoundDate,
    totalFunding: c.funding?.totalRaised,
    currentlyHiring: c.isHiring === true,
    hiringDepartments: c.hiringByDept
      ? Object.keys(c.hiringByDept).filter((dept) => (c.hiringByDept?.[dept] ?? 0) > 0)
      : undefined,
    foundedYear: foundedYearFromCandidate(c),
    techStack: c.techStack?.map((t) => ({ category: t.category, technology: t.technology })),
    signals: [
      ...(c.signals?.map((s) => ({ type: s.type, observedAt: s.observedAt, detail: s.detail })) ?? []),
      ...(c.provenance?.map((p) => ({
        type: "field_provenance",
        observedAt: p.scrapedAt,
        detail: `${p.field}@${p.source}`,
      })) ?? []),
    ],
    updatedAt: c.scrapedAt,
  };
}

export function prospectToDoc(c: ProspectCandidate): ProspectDocument {
  const domain = normalizeDomain(c.companyDomain);
  const pid = prospectId(domain, c.email, c.fullName);
  return {
    prospectId: pid,
    companyId: companyId(domain),
    fullName: c.fullName,
    title: c.title,
    seniority: c.seniority,
    email: c.email,
    companyDomain: domain,
    companyName: c.companyName,
    country: c.country,
    signals: c.contactSignals?.map((s) => ({ type: s.type, observedAt: s.observedAt, detail: s.detail })),
    updatedAt: c.scrapedAt,
  };
}

export function recordsToDocs(records: unknown[]): ProspectDocument[] {
  const docs: ProspectDocument[] = [];
  for (const r of records) {
    const rec = r as Record<string, unknown>;
    if ("domain" in rec && !("companyDomain" in rec)) {
      docs.push(companyToProspectDoc(rec as CompanyCandidate));
    } else if ("companyDomain" in rec) {
      docs.push(prospectToDoc(rec as ProspectCandidate));
    }
  }
  return docs;
}

// Legacy exports for tests
export interface OpenSearchDoc {
  _id: string;
  prospectId: string;
  companyId: string;
  fullName?: string;
  title?: string;
  email?: string;
  companyDomain: string;
  country?: string;
  seniority?: string;
  updatedAt: string;
}

export function toOpenSearchDoc(c: ProspectCandidate): OpenSearchDoc {
  const doc = prospectToDoc(c);
  return { _id: doc.prospectId, ...doc };
}

export interface IngestSummary {
  ingested: number;
  skippedDuplicate: number;
  failed: number;
}

export function buildBulkBatch(candidates: ProspectCandidate[]): {
  docs: OpenSearchDoc[];
  summary: IngestSummary;
} {
  const docs: OpenSearchDoc[] = [];
  const seen = new Set<string>();
  let skippedDuplicate = 0;
  for (const c of candidates) {
    const doc = toOpenSearchDoc(c);
    if (seen.has(doc._id)) {
      skippedDuplicate += 1;
      continue;
    }
    seen.add(doc._id);
    docs.push(doc);
  }
  return { docs, summary: { ingested: docs.length, skippedDuplicate, failed: 0 } };
}
