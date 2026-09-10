import type { CompanyData, FirmographicsProvider } from "../types.js";
import { fetchJson, qs } from "./http.js";

export const CORESIGNAL_BASE_URL = "https://api.coresignal.com/cdapi/v2";

/** Coresignal — headcount + jobs historical data (strategy §7.2 / E8.4). */
export class CoresignalFirmographics implements FirmographicsProvider {
  readonly name = "coresignal";
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = CORESIGNAL_BASE_URL,
    private readonly timeoutMs?: number
  ) {}

  async fetchCompany(domain: string, name?: string): Promise<CompanyData | null> {
    const url = `${this.baseUrl}/company_multi_source/enrich?${qs({ website: domain })}`;
    const body = await fetchJson<{
      name?: string;
      industry?: string;
      employees_count?: number;
      hq_country?: string;
      hq_city?: string;
      founded?: string;
    }>(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      timeoutMs: this.timeoutMs,
    });
    if (!body.name && !body.industry) return null;
    return {
      companyName: body.name ?? name,
      industry: body.industry,
      employeeCount: body.employees_count,
      hqCountry: body.hq_country,
      hqCity: body.hq_city,
      foundedDate: body.founded,
    };
  }
}
