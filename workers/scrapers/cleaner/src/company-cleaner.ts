import {
  companyCandidateSchema,
  toEmployeeBucket,
  type CompanyCandidate,
} from "@skout/scraper-contracts";
import { detectTechnologies } from "./wappalyzer.js";
import { collectSignals } from "./signals.js";

const QUALITY_THRESHOLD = Number(process.env.CLEANER_QUALITY_THRESHOLD ?? 30);

export interface CompanyCleanResult {
  clean: CompanyCandidate[];
  quarantined: { record: unknown; reason: string }[];
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
}

const SKIP_DOMAINS = /(?:linkedin\.com|licdn\.com|licdn\.cn|microsoft\.com|google\.com|gstatic\.com)$/i;

/** Extract company website domain from LinkedIn company page HTML / seed URL. */
export function deriveLinkedInCompanyDomain(input: {
  url?: string;
  payload: Record<string, unknown>;
}): string | null {
  const seed = String(input.payload.seed ?? input.url ?? "");
  const html = String(input.payload.html ?? "");

  const embedded = html.match(/"websiteUrl":"(https?:[^"]+)"/i)?.[1];
  if (embedded) {
    const d = normalizeDomain(embedded);
    if (d && !SKIP_DOMAINS.test(d)) return d;
  }

  for (const match of html.matchAll(/https?:\/\/(?:www\.)?([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/gi)) {
    const d = normalizeDomain(match[0]);
    if (d && !SKIP_DOMAINS.test(d)) return d;
  }

  const slug = seed.match(/linkedin\.com\/company\/([^/?#]+)/i)?.[1];
  if (slug && slug !== "company") return `${slug.replace(/-/g, "")}.com`;

  return null;
}

export function rawToCompanyCandidate(raw: {
  source: string;
  payload: Record<string, unknown>;
  scrapedAt?: string;
  rawS3Key?: string;
  html?: string;
  url?: string;
}): CompanyCandidate | null {
  const p = raw.payload;
  let domain: string | undefined =
    (p.domain as string) ??
    (p.company_domain as string) ??
    (p.homepage_url as string) ??
    (p.name as string);

  if (!domain && raw.source === "linkedin") {
    domain = deriveLinkedInCompanyDomain({ url: raw.url, payload: p }) ?? undefined;
  }
  if (!domain) return null;

  const html = raw.html ?? (p.html as string) ?? "";
  const techStack = html ? detectTechnologies(html) : [];

  const candidate: CompanyCandidate = {
    source: raw.source as CompanyCandidate["source"],
    domain: normalizeDomain(String(domain)),
    companyName: (p.companyName as string) ?? (p.name as string) ?? (p.title as string),
    description: p.description as string | undefined,
    industry: p.industry as string | undefined,
    hqCountry: (p.jurisdiction_code as string) ?? (p.hqCountry as string),
    hqCity: p.hqCity as string | undefined,
    employeeCount: p.employeeCount as number | undefined,
    employeeBucket: toEmployeeBucket(p.employeeCount as number | undefined),
    techStack: techStack.length ? techStack : undefined,
    isPublic: raw.source === "sec-edgar" ? true : undefined,
    isHiring: p.isHiring === true ? true : undefined,
    openJobs: typeof p.openJobs === "number" ? p.openJobs : undefined,
    scrapedAt: raw.scrapedAt ?? new Date().toISOString(),
    rawS3Key: raw.rawS3Key,
  };

  candidate.signals = collectSignals(candidate);
  candidate.qualityScore = companyQualityScore(candidate);
  return candidate;
}

function companyQualityScore(c: CompanyCandidate): number {
  let score = 0;
  if (c.domain) score += 30;
  if (c.companyName) score += 20;
  if (c.description) score += 15;
  if (c.industry) score += 10;
  if (c.techStack?.length) score += 15;
  if (c.signals?.length) score += 10;
  return Math.min(100, score);
}

/** Parse raw scrape records into validated company candidates. */
export function cleanCompanies(records: unknown[]): CompanyCleanResult {
  const clean: CompanyCandidate[] = [];
  const quarantined: { record: unknown; reason: string }[] = [];
  const seen = new Set<string>();

  for (const record of records) {
    const r = record as {
      source?: string;
      payload?: Record<string, unknown>;
      scrapedAt?: string;
      url?: string;
    };
    if (!r.source || !r.payload) {
      quarantined.push({ record, reason: "missing source or payload" });
      continue;
    }
    const candidate = rawToCompanyCandidate({
      source: r.source,
      payload: r.payload,
      scrapedAt: r.scrapedAt,
      url: r.url,
      html: (r.payload as { html?: string }).html,
    });
    if (!candidate) {
      quarantined.push({ record, reason: "could not derive domain" });
      continue;
    }
    const parsed = companyCandidateSchema.safeParse(candidate);
    if (!parsed.success) {
      quarantined.push({ record, reason: parsed.error.message });
      continue;
    }
    if ((parsed.data.qualityScore ?? 0) < QUALITY_THRESHOLD) {
      quarantined.push({ record, reason: `quality ${parsed.data.qualityScore} < ${QUALITY_THRESHOLD}` });
      continue;
    }
    if (seen.has(parsed.data.domain)) {
      quarantined.push({ record, reason: "duplicate domain" });
      continue;
    }
    seen.add(parsed.data.domain);
    clean.push(parsed.data);
  }

  return { clean, quarantined };
}

export { detectTechnologies } from "./wappalyzer.js";
export { collectSignals } from "./signals.js";
