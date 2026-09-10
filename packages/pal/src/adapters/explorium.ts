import type { CompanyData, FirmographicsProvider } from "../types.js";
import { fetchJson } from "./http.js";

export const EXPLORIUM_BASE_URL = "https://api.explorium.ai/v1";

function normalizeDomain(domain: string): string {
  return domain.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] ?? domain;
}

/** Map Explorium employee buckets (e.g. "51-200", "10001+") to a numeric hint. */
function parseEmployeeRange(range?: string): number | undefined {
  if (!range) return undefined;
  const plus = range.match(/^(\d+)\+$/);
  if (plus) return Number(plus[1]);
  const span = range.match(/^(\d+)-(\d+)$/);
  if (span) return Math.round((Number(span[1]) + Number(span[2])) / 2);
  const exact = Number(range);
  return Number.isFinite(exact) ? exact : undefined;
}

/** Explorium — match then firmographics enrich (strategy §7.2 / E8.4). */
export class ExploriumFirmographics implements FirmographicsProvider {
  readonly name = "explorium";
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = EXPLORIUM_BASE_URL,
    private readonly timeoutMs?: number
  ) {}

  async fetchCompany(domain: string, name?: string): Promise<CompanyData | null> {
    const normalizedDomain = normalizeDomain(domain);
    const match = await fetchJson<{ matched_businesses?: Array<{ business_id?: string }> }>(
      `${this.baseUrl}/businesses/match`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", api_key: this.apiKey },
        body: JSON.stringify({
          businesses_to_match: [{ domain: normalizedDomain, name: name ?? undefined }],
        }),
        timeoutMs: this.timeoutMs,
      }
    );
    const businessId = match.matched_businesses?.[0]?.business_id;
    if (!businessId) return null;

    const enrich = await fetchJson<{ data?: Record<string, unknown> }>(
      `${this.baseUrl}/businesses/firmographics/enrich`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", api_key: this.apiKey },
        body: JSON.stringify({ business_id: businessId }),
        timeoutMs: this.timeoutMs,
      }
    );
    const d = enrich.data;
    if (!d) return null;
    return {
      companyName: (d.name as string) ?? name,
      industry:
        (d.linkedin_industry_category as string | undefined) ??
        (d.naics_description as string | undefined),
      employeeCount: parseEmployeeRange(d.number_of_employees_range as string | undefined),
      hqCountry: d.country_name as string | undefined,
      hqCity: d.city_name as string | undefined,
    };
  }
}
