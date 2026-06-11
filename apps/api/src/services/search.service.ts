import { createHash } from "node:crypto";
import { seniorityEnum, type SearchProspectsRequest, type SearchProspectsResponse } from "@skout/shared";
import {
  getProspectById as osGetById,
  searchProspects as osSearch,
  type OpenSearchConfig,
  type SearchFilters,
} from "@skout/opensearch";
import type { Env } from "../config/env.js";

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
    industry: typeof f.industry === "string" ? f.industry : undefined,
    country: typeof f.country === "string" ? f.country : undefined,
    seniority: typeof f.seniority === "string" ? f.seniority : undefined,
    minEmployees: typeof f.minEmployees === "number" ? f.minEmployees : undefined,
    maxEmployees: typeof f.maxEmployees === "number" ? f.maxEmployees : undefined,
    tech: typeof f.tech === "string" ? f.tech : undefined,
    signal: typeof f.signal === "string" ? f.signal : undefined,
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

    return this.demoSearch(page, pageSize);
  }

  async getProspectById(prospectId: string) {
    const cfg = osConfig(this.env);
    if (cfg) {
      const doc = await osGetById(cfg, prospectId);
      if (doc) {
        return {
          prospectId: doc.prospectId,
          companyId: doc.companyId,
          fullName: doc.fullName ?? doc.companyName ?? "Unknown",
          title: doc.title ?? "",
          seniority: "unknown" as const,
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

  private demoSearch(page: number, pageSize: number): SearchProspectsResponse {
    const results = Array.from({ length: Math.min(pageSize, 5) }, (_, i) => ({
      prospectId: createHash("sha256").update(`demo-${i}`).digest("hex"),
      companyId: createHash("sha256").update(`company-${i}`).digest("hex"),
      fullName: `Demo Prospect ${i + 1 + (page - 1) * pageSize}`,
      title: i % 2 === 0 ? "VP Sales" : "Director of Marketing",
      seniority: "vp" as const,
      country: i % 3 === 0 ? "US" : "DE",
      industry: "Software",
      companyDomain: `example${i + 1}.com`,
      employeeCount: 250 + i * 100,
    }));
    return { results, total: 200_000_000, page, pageSize, cached: false };
  }
}

export function createSearchService(env: Env) {
  return new SearchService(env);
}
