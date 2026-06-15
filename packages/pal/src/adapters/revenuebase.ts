import type { CompanyData, FirmographicsProvider } from "../types.js";
import { fetchJson } from "./http.js";

export const REVENUEBASE_BASE_URL = "https://api.revenuebase.ai";

interface RevenueBaseCompany {
  company_name?: string;
  headquarters_city?: string;
  headquarters_country?: string;
  headquarters_state?: string;
}

/** Strip legacy `/v1` suffix so env overrides stay compatible. */
function apiRoot(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "");
}

/** Derive a search label from domain when the caller did not supply a company name. */
function companyLabelFromDomain(domain: string, name?: string): string {
  if (name?.trim()) return name.trim();
  const host = domain.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] ?? domain;
  const slug = host.split(".")[0] ?? host;
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

/**
 * RevenueBase — semantic company resolve (strategy §7.2 / E8.2).
 * Key: REVENUEBASE_API_KEY (header `x-key`)
 */
export class RevenueBaseFirmographics implements FirmographicsProvider {
  readonly name = "revenuebase";
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = REVENUEBASE_BASE_URL,
    private readonly timeoutMs?: number
  ) {}

  async fetchCompany(domain: string, name?: string): Promise<CompanyData | null> {
    const companyName = companyLabelFromDomain(domain, name);
    const body = await fetchJson<{ companies?: RevenueBaseCompany[] }>(
      `${apiRoot(this.baseUrl)}/v2/organization/resolve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-key": this.apiKey },
        body: JSON.stringify({ company_name: companyName, result_count: 1 }),
        timeoutMs: this.timeoutMs,
      }
    );
    const c = body.companies?.[0];
    if (!c) return null;
    return {
      companyName: c.company_name ?? companyName,
      hqCountry: c.headquarters_country,
      hqCity: c.headquarters_city,
    };
  }
}
