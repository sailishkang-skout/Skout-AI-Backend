import type { CompanyData, FirmographicsProvider } from "../types.js";
import { fetchJson } from "./http.js";

export const EXPLORIUM_BASE_URL = "https://api.explorium.ai/v1";

/** Explorium — multi-signal firmographics + events (strategy §7.2 / E8.4). */
export class ExploriumFirmographics implements FirmographicsProvider {
  readonly name = "explorium";
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = EXPLORIUM_BASE_URL,
    private readonly timeoutMs?: number
  ) {}

  async fetchCompany(domain: string, name?: string): Promise<CompanyData | null> {
    const body = await fetchJson<{ data?: Record<string, unknown> }>(
      `${this.baseUrl}/companies/enrich`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", api_key: this.apiKey },
        body: JSON.stringify({ domain, company_name: name }),
        timeoutMs: this.timeoutMs,
      }
    );
    const d = body.data;
    if (!d) return null;
    return {
      companyName: (d.name as string) ?? name,
      industry: d.industry as string | undefined,
      employeeCount: d.employee_count as number | undefined,
      hqCountry: d.country as string | undefined,
      hqCity: d.city as string | undefined,
    };
  }
}
