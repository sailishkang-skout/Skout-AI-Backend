import type { PhoneData, PhoneProvider } from "../types.js";
import { fetchJson, qs } from "./http.js";

/**
 * Datagma — on-demand phone enrichment (strategy §6 / E7.1).
 * Docs: https://datagmaapi.readme.io/reference/find-a-phone-number
 * Key: DATAGMA_API_KEY (query param `apiId`)
 *
 * Prefer v1/search when email or LinkedIn URL is known; otherwise v2/full with phoneFull.
 */
export const DATAGMA_BASE_URL = "https://gateway.datagma.net/api/ingress";

/** Strip legacy `/v8` suffix so env overrides stay compatible. */
function apiRoot(baseUrl: string): string {
  return baseUrl.replace(/\/v8\/?$/, "");
}

/** Datagma returns HTTP 200 with `{ code, message }` on billing/auth errors. */
function assertDatagmaOk(body: Record<string, unknown>, context: string): void {
  const code = body.code;
  if (typeof code === "number" && code !== 0) {
    throw new Error(String(body.message ?? `Datagma ${context} error (code ${code})`));
  }
}

export class DatagmaPhone implements PhoneProvider {
  readonly name = "datagma";
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = DATAGMA_BASE_URL,
    private readonly timeoutMs?: number
  ) {}

  async fetchPhone(
    fullName: string,
    domain: string,
    linkedinUrl?: string,
    email?: string
  ): Promise<PhoneData | null> {
    const root = apiRoot(this.baseUrl);

    if (email || linkedinUrl) {
      const search = await fetchJson<Record<string, unknown>>(
      `${root}/v1/search?${qs({
        apiId: this.apiKey,
        email,
        username: linkedinUrl,
        minimumMatch: 1,
      })}`, { timeoutMs: this.timeoutMs });
      assertDatagmaOk(search, "search");
      const phones = (search.person as { phones?: Array<{ displayInternational?: string; display?: string }> } | undefined)?.phones;
      const fromSearch = phones?.[0]?.displayInternational ?? phones?.[0]?.display;
      if (fromSearch) return { mobile: fromSearch };
    }

    const enrich = await fetchJson<Record<string, unknown>>(
    `${root}/v2/full?${qs({
      apiId: this.apiKey,
      fullName,
      data: domain,
      phoneFull: "true",
    })}`, { timeoutMs: this.timeoutMs });
    assertDatagmaOk(enrich, "full");
    const phoneFull = enrich.phoneFull as { phones?: Array<{ displayInternational?: string; display?: string }> } | undefined;
    const fromFull =
      phoneFull?.phones?.[0]?.displayInternational ??
      phoneFull?.phones?.[0]?.display;
    if (fromFull) return { mobile: fromFull };

    return null;
  }
}
