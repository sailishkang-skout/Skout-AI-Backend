import {
  companyCandidateSchema,
  companyStageEnum,
  toEmployeeBucket,
  type CompanyCandidate,
  type FieldProvenance,
  type ScrapeSource,
} from "@skout/scraper-contracts";
import { detectTechnologies } from "./wappalyzer.js";
import { collectSignals } from "./signals.js";
import { parseSecEdgarPayload } from "./sec-parser.js";
import { classifyIndustry } from "./industry-classifier.js";

const QUALITY_THRESHOLD = Number(process.env.CLEANER_QUALITY_THRESHOLD ?? 30);

export interface CompanyCleanResult {
  clean: CompanyCandidate[];
  quarantined: { record: unknown; reason: string }[];
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
}

const SKIP_DOMAINS = /(?:linkedin\.com|licdn\.com|licdn\.cn|microsoft\.com|google\.com|gstatic\.com)$/i;

function fieldProvenance(
  fields: Array<[string, unknown]>,
  source: ScrapeSource | string,
  scrapedAt: string
): FieldProvenance[] {
  return fields
    .filter(([, value]) => value != null && value !== "" && !(Array.isArray(value) && value.length === 0))
    .map(([field]) => ({
      field,
      source,
      scrapedAt,
      confidence: 0.85,
    }));
}

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
  if (!domain && raw.source === "sec-edgar") {
    const sec = parseSecEdgarPayload(p);
    domain = (p.domain as string) ?? (sec.companyName ? `${String(p.ticker ?? sec.companyName).toLowerCase().replace(/\s+/g, "")}.com` : undefined);
  }
  if (!domain && raw.source === "crunchbase") {
    domain = (p.domain as string) ?? undefined;
  }
  if (!domain && raw.source === "google-business") {
    const query = String(p.query ?? p.companyName ?? "");
    if (query.includes(".")) domain = query;
  }
  if (!domain) return null;

  const normalizedDomain = normalizeDomain(String(domain));
  const html = raw.html ?? (p.html as string) ?? "";
  const scrapedAt = raw.scrapedAt ?? new Date().toISOString();
  const techStack = html ? detectTechnologies(html, { domain: normalizedDomain }) : [];

  const secFields = raw.source === "sec-edgar" ? parseSecEdgarPayload(p) : {};
  const fundingPayload = (p.funding as CompanyCandidate["funding"]) ?? secFields.funding;

  const foundedYear =
    typeof p.foundedYear === "number"
      ? p.foundedYear
      : typeof p.foundedDate === "string"
        ? Number(p.foundedDate.slice(0, 4))
        : undefined;

  const stageRaw = p.companyStage as string | undefined;
  const companyStage = stageRaw ? companyStageEnum.safeParse(stageRaw).data : undefined;

  const companyName = (p.companyName as string) ?? secFields.companyName ?? (p.name as string) ?? (p.title as string);
  const description = p.description as string | undefined;
  const industry = p.industry as string | undefined;
  const employeeCount = (p.employeeCount as number | undefined) ?? undefined;
  const isHiring = p.isHiring === true ? true : undefined;
  const openJobs = typeof p.openJobs === "number" ? p.openJobs : undefined;
  const hiringByDept =
    p.hiringByDept && typeof p.hiringByDept === "object"
      ? (p.hiringByDept as Record<string, number>)
      : undefined;
  const annualRevenue =
    typeof p.annualRevenue === "number" ? p.annualRevenue : secFields.annualRevenue;

  const candidate: CompanyCandidate = {
    source: raw.source as CompanyCandidate["source"],
    domain: normalizedDomain,
    companyName,
    description,
    keywords: Array.isArray(p.keywords) ? (p.keywords as string[]) : undefined,
    industry,
    hqCountry: (p.jurisdiction_code as string) ?? (p.hqCountry as string),
    hqState: p.hqState as string | undefined,
    hqCity: p.hqCity as string | undefined,
    employeeCount,
    employeeBucket: toEmployeeBucket(employeeCount),
    annualRevenue,
    companyStage,
    funding: fundingPayload,
    techStack: techStack.length ? techStack : undefined,
    isPublic: raw.source === "sec-edgar" ? true : secFields.isPublic,
    isHiring,
    openJobs,
    hiringByDept,
    foundedDate: foundedYear ? `${foundedYear}-01-01` : (p.foundedDate as string | undefined),
    scrapedAt,
    rawS3Key: raw.rawS3Key,
    provenance: fieldProvenance(
      [
        ["domain", normalizedDomain],
        ["companyName", companyName],
        ["description", description],
        ["industry", industry],
        ["employeeCount", employeeCount],
        ["foundedDate", foundedYear],
        ["companyStage", companyStage],
        ["annualRevenue", annualRevenue],
        ["isHiring", isHiring],
        ["openJobs", openJobs],
        ["techStack", techStack.length ? techStack : undefined],
      ],
      raw.source,
      scrapedAt
    ),
  };

  candidate.signals = collectSignals(candidate);
  candidate.qualityScore = companyQualityScore(candidate);
  return candidate;
}

function companyQualityScore(c: CompanyCandidate): number {
  let score = 0;
  if (c.domain) score += 25;
  if (c.companyName) score += 20;
  if (c.description) score += 15;
  if (c.industry) score += 10;
  if (c.employeeCount) score += 10;
  if (c.foundedDate) score += 5;
  if (c.techStack?.length) score += 10;
  if (c.signals?.length) score += 10;
  if (c.isHiring) score += 5;
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
    if (r.payload.mode === "people") continue;
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

/** Industry classification pass after base cleaning (R6.6). */
export async function enrichCompaniesWithClassifier(result: CompanyCleanResult): Promise<CompanyCleanResult> {
  for (const company of result.clean) {
    if (company.industry && (company.qualityScore ?? 0) >= 60) continue;
    const classified = await classifyIndustry(company);
    if (!classified.industry) continue;
    company.industry = classified.industry;
    if (classified.subIndustry) company.subIndustry = classified.subIndustry;
    company.provenance = [
      ...(company.provenance ?? []),
      {
        field: "industry",
        source: classified.source,
        scrapedAt: company.scrapedAt,
        confidence: classified.confidence,
      },
    ];
  }
  return result;
}

/** Parse + classify company records. */
export async function cleanCompaniesAsync(records: unknown[]): Promise<CompanyCleanResult> {
  return enrichCompaniesWithClassifier(cleanCompanies(records));
}

export { detectTechnologies } from "./wappalyzer.js";
export { collectSignals } from "./signals.js";
