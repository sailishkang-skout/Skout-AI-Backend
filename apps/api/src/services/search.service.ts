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
    previousCompany: f.previousCompany,
    contactSignals: f.contactSignals,
    companyName: f.companyName,
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

/**
 * Search service — OpenSearch corpus with demo fallback when OPENSEARCH_URL unset.
 */
export class SearchService {
  constructor(private readonly env: Env) {}

  async searchProspects(body: SearchProspectsRequest): Promise<SearchProspectsResponse> {
    const page = body.page ?? 1;
    const pageSize = body.pageSize ?? 25;
    const cfg = osConfig(this.env);

    if (cfg) {
      try {
        const res = await osSearch(cfg, toFilters(body), page, pageSize);
        return {
          results: res.hits.map((h) => ({
            prospectId: h.prospectId,
            companyId: h.companyId,
            fullName: h.fullName ?? h.companyName ?? "Unknown",
            title: h.title ?? "",
            seniority: VALID_SENIORITIES.has(h.seniority as (typeof seniorityEnum.options)[number])
              ? (h.seniority as (typeof seniorityEnum.options)[number])
              : "unknown",
            country: h.country ?? "",
            industry: h.industry ?? "",
            companyDomain: h.companyDomain,
            employeeCount: h.employeeCount,
          })),
          total: res.total,
          page,
          pageSize,
          cached: false,
        };
      } catch {
        // fall through to demo data
      }
    }

    return this.demoSearch(body, page, pageSize);
  }

  async getProspectById(prospectId: string) {
    const cfg = osConfig(this.env);
    if (cfg) {
      const doc = await osGetById(cfg, prospectId);
      if (doc) {
        return this.toProspectSummary(doc);
      }
    }

    const doc = demoCorpus(this.env).find((row) => row.prospectId === prospectId);
    if (doc) {
      return this.toProspectSummary(doc);
    }

    return {
      prospectId,
      companyId: prospectId,
      fullName: "Demo Prospect",
      title: "VP Sales",
      seniority: "vp" as const,
      country: "US",
      industry: "Software",
      companyDomain: "example.com",
    };
  }

  private toProspectSummary(doc: ProspectDocument) {
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
      employeeCount: doc.employeeCount,
      icpScore: doc.icpScore,
      intentScore: doc.intentScore,
      painPoints: doc.painPoints,
      outreachReadiness: doc.outreachReadiness,
    };
  }

  private demoSearch(body: SearchProspectsRequest, page: number, pageSize: number): SearchProspectsResponse {
    const filtered = filterDemoCorpus(demoCorpus(this.env), toFilters(body));
    const start = (page - 1) * pageSize;
    const slice = filtered.slice(start, start + pageSize);
    return {
      results: slice.map((h) => ({
        prospectId: h.prospectId,
        companyId: h.companyId,
        fullName: h.fullName ?? h.companyName ?? "Unknown",
        title: h.title ?? "",
        seniority: VALID_SENIORITIES.has(h.seniority as (typeof seniorityEnum.options)[number])
          ? (h.seniority as (typeof seniorityEnum.options)[number])
          : "unknown",
        country: h.country ?? "",
        industry: h.industry ?? "",
        companyDomain: h.companyDomain,
        employeeCount: h.employeeCount,
        icpScore: h.icpScore,
        intentScore: h.intentScore,
        painPoints: h.painPoints,
        outreachReadiness: h.outreachReadiness,
      })),
      total: filtered.length,
      page,
      pageSize,
      cached: false,
    };
  }
}

export function createSearchService(env: Env) {
  return new SearchService(env);
}
