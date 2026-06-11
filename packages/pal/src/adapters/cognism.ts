import { splitName } from "../email-patterns.js";
import type { PhoneData, PhoneProvider } from "../types.js";
import { fetchJson } from "./http.js";

export const COGNISM_BASE_URL = "https://app.cognism.com/api";

/** Cognism — EMEA phone-verified fallback after Datagma (strategy §6 / E7.3). */
export class CognismPhone implements PhoneProvider {
  readonly name = "cognism";
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = COGNISM_BASE_URL,
    private readonly timeoutMs?: number
  ) {}

  async fetchPhone(fullName: string, domain: string, linkedinUrl?: string): Promise<PhoneData | null> {
    const { first, last } = splitName(fullName);
    const body = await fetchJson<{ results?: { mobile?: string; direct?: string }[] }>(
      `${this.baseUrl}/search/contact/enrich`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          firstName: first,
          lastName: last,
          companyWebsite: domain,
          linkedinUrl,
        }),
        timeoutMs: this.timeoutMs,
      }
    );
    const hit = body.results?.[0];
    if (!hit?.mobile && !hit?.direct) return null;
    return { mobile: hit.mobile, direct: hit.direct };
  }
}
