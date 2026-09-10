import { isSyntheticCaptureDomain, linkedinHandleFromUrl } from "../capture-domains.js";
import { splitName } from "../email-patterns.js";
import type {
  EmailFindContext,
  EmailFinder,
  EmailVerification,
  EmailVerifier,
  EmailVerdict,
  FoundEmail,
} from "../types.js";
import { fetchJson, qs } from "./http.js";

export const HUNTER_BASE_URL = "https://api.hunter.io/v2";

/**
 * Hunter.io — Email Finder + Email Verifier.
 * Docs: https://hunter.io/api-documentation/v2
 * Key: HUNTER_API_KEY
 */
export class HunterEmailFinder implements EmailFinder {
  readonly name = "hunter";
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = HUNTER_BASE_URL,
    private readonly timeoutMs?: number
  ) {}

  async findEmail(
    fullName: string,
    domain: string,
    context?: EmailFindContext
  ): Promise<FoundEmail | null> {
    const trimmedName = fullName.trim();
    const { first, last } = splitName(trimmedName);
    const params: Record<string, string | undefined> = { api_key: this.apiKey };

    if (isSyntheticCaptureDomain(domain)) {
      const handle = linkedinHandleFromUrl(context?.linkedinUrl);
      if (handle) {
        params.linkedin_handle = handle;
        if (trimmedName) params.full_name = trimmedName;
      } else if (context?.companyName?.trim()) {
        params.company = context.companyName.trim();
        if (trimmedName) params.full_name = trimmedName;
      } else {
        return null;
      }
    } else {
      params.domain = domain;
      if (first && last) {
        params.first_name = first;
        params.last_name = last;
      } else if (trimmedName) {
        params.full_name = trimmedName;
      } else {
        return null;
      }
    }

    const url = `${this.baseUrl}/email-finder?${qs(params)}`;
    const body = await fetchJson<{ data?: { email?: string; score?: number } }>(url, {
      timeoutMs: this.timeoutMs,
    });
    if (!body.data?.email) return null;
    return { email: body.data.email, confidence: (body.data.score ?? 0) / 100 };
  }
}

const HUNTER_STATUS: Record<string, EmailVerdict> = {
  valid: "valid",
  invalid: "invalid",
  accept_all: "catch_all",
  webmail: "risky",
  disposable: "risky",
  unknown: "unknown",
};

export class HunterEmailVerifier implements EmailVerifier {
  readonly name = "hunter-verify";
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = HUNTER_BASE_URL,
    private readonly timeoutMs?: number
  ) {}

  async verify(email: string): Promise<EmailVerification> {
    const url = `${this.baseUrl}/email-verifier?${qs({ email, api_key: this.apiKey })}`;
    const body = await fetchJson<{ data?: { status?: string; score?: number } }>(url, {
      timeoutMs: this.timeoutMs,
    });
    const status = HUNTER_STATUS[body.data?.status ?? "unknown"] ?? "unknown";
    return {
      status,
      deliverabilityScore: body.data?.score ?? 0,
      catchAll: status === "catch_all",
      risky: status === "risky",
    };
  }
}
