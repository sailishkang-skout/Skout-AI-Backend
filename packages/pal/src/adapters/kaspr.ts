import { splitName } from "../email-patterns.js";
import type { PhoneData, PhoneProvider } from "../types.js";
import { fetchJson } from "./http.js";

export const KASPR_BASE_URL = "https://api.developers.kaspr.io";

/** Kaspr — EU phone enrichment (strategy §6). */
export class KasprPhone implements PhoneProvider {
  readonly name = "kaspr";
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = KASPR_BASE_URL,
    private readonly timeoutMs?: number
  ) {}

  async fetchPhone(
    fullName: string,
    domain: string,
    linkedinUrl?: string,
    email?: string
  ): Promise<PhoneData | null> {
    const { first, last } = splitName(fullName);
    const body = await fetchJson<{ data?: { phone?: string; mobilePhone?: string } }>(
      `${this.baseUrl}/profile/linkedin`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          firstName: first,
          lastName: last,
          companyDomain: domain,
          linkedinUrl,
          email,
        }),
        timeoutMs: this.timeoutMs,
      }
    );
    const phone = body.data?.mobilePhone ?? body.data?.phone;
    return phone ? { mobile: phone } : null;
  }
}
