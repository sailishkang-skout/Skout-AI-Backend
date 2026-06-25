import { splitName } from "../email-patterns.js";
import type { PhoneData, PhoneProvider } from "../types.js";
import { fetchJson, qs } from "./http.js";

export const LUSHA_BASE_URL = "https://api.lusha.com";

/** Lusha — phone enrichment with ISO 27701 compliance (strategy §6). */
export class LushaPhone implements PhoneProvider {
  readonly name = "lusha";
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = LUSHA_BASE_URL,
    private readonly timeoutMs?: number
  ) {}

  async fetchPhone(
    fullName: string,
    domain: string,
    linkedinUrl?: string,
    email?: string
  ): Promise<PhoneData | null> {
    const { first, last } = splitName(fullName);
    const body = await fetchJson<{ contact?: { phoneNumbers?: Array<{ number?: string }> } }>(
      `${this.baseUrl}/v2/person?${qs({
        firstName: first,
        lastName: last,
        company: domain,
        linkedinUrl,
        email,
      })}`,
      {
        headers: {
          api_key: this.apiKey,
        },
        timeoutMs: this.timeoutMs,
      }
    );
    const number = body.contact?.phoneNumbers?.[0]?.number;
    return number ? { mobile: number } : null;
  }
}
