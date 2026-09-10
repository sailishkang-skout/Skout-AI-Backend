import { splitName } from "../email-patterns.js";
import type { PhoneData, PhoneProvider } from "../types.js";
import { fetchJson } from "./http.js";

/**
 * ContactOut — phone fallback after Datagma (strategy §6).
 * Docs: https://api.contactout.com/ — POST /v1/people/enrich
 * Key: CONTACTOUT_API_KEY (header `token`)
 */
export const CONTACTOUT_BASE_URL = "https://api.contactout.com";

function normalizeDomain(domain: string): string {
  return domain.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] ?? domain;
}

function pickPhone(profile: Record<string, unknown>): string | undefined {
  const phones = profile.phone;
  if (!Array.isArray(phones)) return undefined;
  for (const entry of phones) {
    if (typeof entry === "string" && entry.trim()) return entry.trim();
    if (entry && typeof entry === "object") {
      const obj = entry as Record<string, unknown>;
      const value =
        (obj.display as string | undefined) ??
        (obj.number as string | undefined) ??
        (obj.phone as string | undefined);
      if (value?.trim()) return value.trim();
    }
  }
  return undefined;
}

function isSampleResponse(body: Record<string, unknown>): boolean {
  const message = String(body.message ?? "");
  if (/sample response/i.test(message)) return true;
  const profile = body.profile as Record<string, unknown> | undefined;
  return profile?.full_name === "Example Person";
}

export class ContactOutPhone implements PhoneProvider {
  readonly name = "contactout";
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = CONTACTOUT_BASE_URL,
    private readonly timeoutMs?: number
  ) {}

  async fetchPhone(
    fullName: string,
    domain: string,
    linkedinUrl?: string,
    email?: string
  ): Promise<PhoneData | null> {
    const { first, last } = splitName(fullName);
    const body = await fetchJson<Record<string, unknown>>(
      `${this.baseUrl.replace(/\/$/, "")}/v1/people/enrich`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          token: this.apiKey,
        },
        body: JSON.stringify({
          full_name: fullName,
          first_name: first,
          last_name: last,
          email: email ?? undefined,
          linkedin_url: linkedinUrl ?? undefined,
          company_domain: normalizeDomain(domain),
          include: ["phone"],
        }),
        timeoutMs: this.timeoutMs,
      }
    );

    const profile = body.profile as Record<string, unknown> | undefined;
    if (!profile) return null;

    const phone = pickPhone(profile);
    if (!phone) return null;

    if (isSampleResponse(body)) {
      return {
        mobile: phone,
        sampleData: true,
        sampleMessage: String(body.message ?? "ContactOut sample response"),
      };
    }

    return { mobile: phone };
  }
}
