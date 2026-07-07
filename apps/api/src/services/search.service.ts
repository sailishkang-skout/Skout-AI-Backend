import { seniorityEnum, type SearchProspectsRequest, type SearchProspectsResponse } from "@skout/shared";
import {
  buildDemoCorpus,
  filterDemoCorpus,
  getProspectById as osGetById,
  searchProspects as osSearch,
  type OpenSearchConfig,
  type ProspectDocument,
  type SearchFilters,
} from "@skout/opensearch";
import type { Env } from "../config/env.js";
import { HttpError } from "../utils/http.js";

let cachedDemoCorpus: ProspectDocument[] | null = null;

function demoCorpus(env: Env): ProspectDocument[] {
  if (!cachedDemoCorpus) {
    cachedDemoCorpus = buildDemoCorpus(env.DEMO_CORPUS_SIZE);
  }
  return cachedDemoCorpus;
}

function osConfig(env: Env): OpenSearchConfig | null {
  if (!env.OPENSEARCH_URL) return null;
  return {
    url: env.OPENSEARCH_URL,
    username: env.OPENSEARCH_USERNAME,
    password: env.OPENSEARCH_PASSWORD,
    index: env.OPENSEARCH_INDEX,
  };
}

function toFilters(body: SearchProspectsRequest): SearchFilters {
  const f = body.filters ?? {};
  return {
    query: body.query,
    fullName: f.fullName,
    jobTitle: f.jobTitle,
    department: f.department,
    seniority: f.seniority,
    jobFunction: f.jobFunction,
    emailAvailable: f.emailAvailable,
    phoneAvailable: f.phoneAvailable,
    linkedInAvailable: f.linkedInAvailable,
    minYearsAtCompany: f.minYearsAtCompany,
    minYearsInRole: f.minYearsInRole,
    minTotalYearsExperience: f.minTotalYearsExperience,
    previousCompany: f.previousCompany,
    minFoundedYear: f.minFoundedYear,
    maxFoundedYear: f.maxFoundedYear,
    minHeadcountGrowth: f.minHeadcountGrowth,
    companyEmailProvider: f.companyEmailProvider,
    minIntentScore: f.minIntentScore,
    excludeDuplicates: f.excludeDuplicates,
    maxPerCompany: f.maxPerCompany,
    contactSignals: f.contactSignals,
    companyName: f.companyName,
    companyDomain: f.companyDomain,
    keyword: f.keyword,
    industry: f.industry,
    subIndustry: f.subIndustry,
    country: f.country,
    state: f.state,
    city: f.city,
    minEmployees: f.minEmployees,
    maxEmployees: f.maxEmployees,
    companyStage: f.companyStage,
    lastFundingRound: f.lastFundingRound,
    minRevenue: f.minRevenue,
    maxRevenue: f.maxRevenue,
    currentlyHiring: f.currentlyHiring,
    hiringDepartments: f.hiringDepartments,
    companySignals: f.companySignals,
    tech: f.tech,
    signal: f.signal,
  };
}

const VALID_SENIORITIES = new Set(seniorityEnum.options);

function recordTypeFor(doc: ProspectDocument): "person" | "company" {
  if (doc.title || doc.email || doc.fullName) return "person";
  return "company";
}

function mapDocToSummary(doc: ProspectDocument) {
  return {
    prospectId: doc.prospectId,
    companyId: doc.companyId,
    fullName: doc.fullName ?? doc.companyName ?? "Unknown",
    title: doc.title ?? "",
    seniority: VALID_SENIORITIES.has(doc.seniority as (typeof seniorityEnum.options)[number])
      ? (doc.seniority as (typeof seniorityEnum.options)[number])
      : ("unknown" as const),
    country: doc.country ?? "",
    industry: doc.industry ?? "",
    companyDomain: doc.companyDomain,
    companyName: doc.companyName,
    recordType: recordTypeFor(doc),
    employeeCount: doc.employeeCount,
    icpScore: doc.icpScore,
    intentScore: doc.intentScore,
    painPoints: doc.painPoints,
    outreachReadiness: doc.outreachReadiness,
    signals: doc.signals?.slice(0, 5),
    techStack: doc.techStack?.slice(0, 6),
    updatedAt: doc.updatedAt,
  };
}

function mapDocToDetail(doc: ProspectDocument) {
  return {
    ...mapDocToSummary(doc),
    signals: doc.signals,
    techStack: doc.techStack,
    email: doc.email,
    phone: doc.phone,
    linkedinUrl: doc.linkedinUrl,
    department: doc.department,
    jobFunction: doc.jobFunction,
    subIndustry: doc.subIndustry,
    state: doc.state,
    city: doc.city,
    employeeBucket: doc.employeeBucket,
    companyStage: doc.companyStage,
    annualRevenue: doc.annualRevenue,
    lastFundingRound: doc.lastFundingRound,
    lastFundingDate: doc.lastFundingDate,
    totalFunding: doc.totalFunding,
    currentlyHiring: doc.currentlyHiring,
    foundedYear: doc.foundedYear,
    headcountGrowth: doc.headcountGrowth,
    companyEmailProvider: doc.companyEmailProvider,
    yearsAtCompany: doc.yearsAtCompany,
    yearsInRole: doc.yearsInRole,
    totalYearsExperience: doc.totalYearsExperience,
    previousCompany: doc.previousCompany,
  };
}

function normalizeSeniority(value: unknown): (typeof seniorityEnum.options)[number] {
  const raw = typeof value === "string" ? value.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  return VALID_SENIORITIES.has(raw as (typeof seniorityEnum.options)[number])
    ? (raw as (typeof seniorityEnum.options)[number])
    : ("unknown" as const);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Build a prospect detail from a stored activation snapshot (LinkedIn capture / manual add). */
export function buildDetailFromSnapshot(
  prospectId: string,
  companyId: string,
  snapshot: Record<string, unknown>,
  updatedAt?: string
) {
  const fullName = str(snapshot.fullName) ?? str(snapshot.companyName) ?? "Unknown";
  const company = (snapshot.company as Record<string, unknown> | undefined) ?? undefined;
  return {
    prospectId,
    companyId,
    fullName,
    title: str(snapshot.title) ?? str(snapshot.headline) ?? "",
    seniority: normalizeSeniority(snapshot.seniority),
    country: str(snapshot.country) ?? "",
    industry: str(snapshot.industry) ?? str(company?.industry) ?? "",
    companyDomain: str(snapshot.companyDomain) ?? "",
    companyName: str(snapshot.companyName) ?? str(company?.name),
    recordType: "person" as const,
    employeeCount: typeof snapshot.employeeCount === "number" ? snapshot.employeeCount : undefined,
    updatedAt: updatedAt ?? new Date().toISOString(),
    email: str(snapshot.email),
    phone: str(snapshot.phone),
    linkedinUrl: str(snapshot.linkedinUrl),
    city: str(snapshot.city),
    state: str(snapshot.state),
  };
}

/**
 * Search service — OpenSearch corpus with demo fallback when OPENSEARCH_URL unset.
 */
export class SearchService {
  constructor(private readonly env: Env) {}

  /** True when this id resolves to a real OpenSearch/demo doc (not the hardcoded fallback). */
  async findExistingProspect(prospectId: string) {
    const cfg = osConfig(this.env);
    if (cfg) {
      const doc = await osGetById(cfg, prospectId).catch(() => null);
      if (doc) return mapDocToDetail(doc);
    }
    const doc = demoCorpus(this.env).find((row) => row.prospectId === prospectId);
    return doc ? mapDocToDetail(doc) : null;
  }

  async searchProspects(body: SearchProspectsRequest): Promise<SearchProspectsResponse> {
    const page = body.page ?? 1;
    const pageSize = body.pageSize ?? 25;
    const cfg = osConfig(this.env);

    if (cfg) {
      try {
        const res = await osSearch(cfg, toFilters(body), page, pageSize);
        return {
          results: res.hits.map((h) => mapDocToSummary(h)),
          total: res.total,
          page,
          pageSize,
          cached: false,
          source: "opensearch" as const,
        };
      } catch (err) {
        throw new HttpError(
          "search_index_unavailable",
          502,
          err instanceof Error ? err.message : "OpenSearch query failed"
        );
      }
    }

    return this.demoSearch(body, page, pageSize);
  }

  async getProspectById(prospectId: string) {
    const cfg = osConfig(this.env);
    if (cfg) {
      const doc = await osGetById(cfg, prospectId).catch(() => null);
      if (doc) return mapDocToDetail(doc);
    }

    const doc = demoCorpus(this.env).find((row) => row.prospectId === prospectId);
    if (doc) return mapDocToDetail(doc);

    return null;
  }

  private demoSearch(body: SearchProspectsRequest, page: number, pageSize: number): SearchProspectsResponse {
    const filtered = filterDemoCorpus(demoCorpus(this.env), toFilters(body));
    const start = (page - 1) * pageSize;
    const slice = filtered.slice(start, start + pageSize);
    return {
      results: slice.map((h) => mapDocToSummary(h)),
      total: filtered.length,
      page,
      pageSize,
      cached: false,
      source: "demo" as const,
    };
  }
}

export function createSearchService(env: Env) {
  return new SearchService(env);
}
