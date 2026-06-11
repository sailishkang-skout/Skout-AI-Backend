import { splitName } from "../email-patterns.js";
import type { PhoneData, PhoneProvider } from "../types.js";
import { fetchJson, qs } from "./http.js";

/**
 * Datagma — on-demand phone enrichment (strategy §6 / E7.1). Only invoked by
 * the engine when the AI lead score clears the gate (> 80).
 * Docs: https://datagma.com/api  (gateway: https://gateway.datagma.net)
 * Key: DATAGMA_API_KEY
 *
 * NOTE: Datagma's response shape varies by plan/endpoint. The adapter scans the
 * payload defensively for phone fields. If your account uses a different path,
 * set DATAGMA_BASE_URL to override the default gateway URL.
 */
export const DATAGMA_BASE_URL = "https://gateway.datagma.net/api/ingress/v8";

export class DatagmaPhone implements PhoneProvider {
  readonly name = "datagma";
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = DATAGMA_BASE_URL,
    private readonly timeoutMs?: number
  ) {}

  async fetchPhone(fullName: string, domain: string, linkedinUrl?: string): Promise<PhoneData | null> {
    const { first, last } = splitName(fullName);
    const url = `${this.baseUrl}/findContact?${qs({
      apiId: this.apiKey,
      firstName: first,
      lastName: last,
      company: domain,
      linkedinUrl,
      phone: "true",
    })}`;

    const body = await fetchJson<Record<string, unknown>>(url, { timeoutMs: this.timeoutMs });
    const phone = pickPhone(body);
    if (!phone) return null;
    return { mobile: phone };
  }
}

/** Defensively extract the first phone-like string from a nested response. */
function pickPhone(obj: unknown, depth = 0): string | undefined {
  if (depth > 5 || obj == null) return undefined;
  if (typeof obj === "string") return /^\+?[\d\s().-]{7,}$/.test(obj.trim()) ? obj.trim() : undefined;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = pickPhone(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof obj === "object") {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (/phone|mobile|cell|tel/i.test(key)) {
        const found = pickPhone(value, depth + 1);
        if (found) return found;
      }
    }
    for (const value of Object.values(obj as Record<string, unknown>)) {
      const found = pickPhone(value, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}
