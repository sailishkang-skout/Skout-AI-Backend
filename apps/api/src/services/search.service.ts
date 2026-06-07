import { createHash } from "node:crypto";
import type { SearchProspectsRequest, SearchProspectsResponse } from "@skout/shared";

/**
 * Search service — cache → OpenSearch (IDs + display fields) → ClickHouse counts.
 * Stub returns synthetic data until OpenSearch/ClickHouse are wired.
 */
export class SearchService {
  async searchProspects(body: SearchProspectsRequest): Promise<SearchProspectsResponse> {
    const page = body.page ?? 1;
    const pageSize = body.pageSize ?? 25;

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

    return {
      results,
      total: 200_000_000,
      page,
      pageSize,
      cached: false,
    };
  }

  async getProspectById(prospectId: string) {
    return {
      prospectId,
      companyId: createHash("sha256").update("example.com").digest("hex"),
      fullName: "Demo Prospect",
      title: "VP Sales",
      seniority: "vp" as const,
      country: "US",
      industry: "Software",
      companyDomain: "example.com",
    };
  }
}

export const searchService = new SearchService();
