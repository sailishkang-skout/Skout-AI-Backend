import type { CompanyData, FirmographicsProvider } from "../types.js";
import { fetchJson, qs } from "./http.js";

export const PDL_BASE_URL = "https://api.peopledatalabs.com/v5";

/**
 * People Data Labs — company enrichment / firmographics (strategy §3 / E8.3).
 * Docs: https://docs.peopledatalabs.com/docs/company-enrichment-api
 * Key: PDL_API_KEY
 */
export class PeopleDataLabsFirmographics implements FirmographicsProvider {
  readonly name = "peopledatalabs";
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = PDL_BASE_URL,
    private readonly timeoutMs?: number
  ) {}

  async fetchCompany(domain: string, name?: string): Promise<CompanyData | null> {
    const url = `${this.baseUrl}/company/enrich?${qs({ website: domain, name })}`;
    const body = await fetchJson<{
      status?: number;
      name?: string;
      industry?: string;
      employee_count?: number;
      estimated_num_employees?: number;
      founded?: number;
      location?: { country?: string; locality?: string };
    }>(url, { headers: { "X-Api-Key": this.apiKey }, timeoutMs: this.timeoutMs });

    if (body.status && body.status !== 200) return null;
    if (!body.name && !body.industry) return null;

    return {
      companyName: body.name ?? name,
      industry: body.industry,
      employeeCount: body.employee_count ?? body.estimated_num_employees,
      hqCountry: body.location?.country,
      hqCity: body.location?.locality,
      foundedDate: body.founded ? `${body.founded}-01-01` : undefined,
    };
  }
}
