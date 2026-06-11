import type { CompanyData, FirmographicsProvider } from "../types.js";
import { fetchJson, qs } from "./http.js";

export const REVENUEBASE_BASE_URL = "https://api.revenuebase.ai/v1";

/**
 * RevenueBase — semantic company match + enrich (strategy §7.2 / E8.2).
 * Key: REVENUEBASE_API_KEY
 */
export class RevenueBaseFirmographics implements FirmographicsProvider {
  readonly name = "revenuebase";
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = REVENUEBASE_BASE_URL,
    private readonly timeoutMs?: number
  ) {}

  async fetchCompany(domain: string, name?: string): Promise<CompanyData | null> {
    const url = `${this.baseUrl}/company/enrich?${qs({ domain, name })}`;
    const body = await fetchJson<{
      company?: {
        name?: string;
        industry?: string;
        employee_count?: number;
        revenue?: number;
        country?: string;
        city?: string;
      };
    }>(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      timeoutMs: this.timeoutMs,
    });
    const c = body.company;
    if (!c) return null;
    return {
      companyName: c.name ?? name,
      industry: c.industry,
      employeeCount: c.employee_count,
      annualRevenue: c.revenue,
      hqCountry: c.country,
      hqCity: c.city,
    };
  }
}
