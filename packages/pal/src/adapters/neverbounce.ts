import type { EmailVerification, EmailVerifier, EmailVerdict } from "../types.js";
import { fetchJson, qs } from "./http.js";

export const NEVERBOUNCE_BASE_URL = "https://api.neverbounce.com/v4";

const RESULT_MAP: Record<string, EmailVerdict> = {
  valid: "valid",
  invalid: "invalid",
  catchall: "catch_all",
  disposable: "risky",
  unknown: "unknown",
};

/**
 * NeverBounce — alternative accuracy-gate verifier (strategy §5 / E4.2).
 * Docs: https://developers.neverbounce.com/
 * Key: NEVERBOUNCE_API_KEY
 */
export class NeverBounce implements EmailVerifier {
  readonly name = "neverbounce";
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = NEVERBOUNCE_BASE_URL,
    private readonly timeoutMs?: number
  ) {}

  async verify(email: string): Promise<EmailVerification> {
    const url = `${this.baseUrl}/single/check?${qs({ key: this.apiKey, email })}`;
    const body = await fetchJson<{ result?: string }>(url, { timeoutMs: this.timeoutMs });
    const status = RESULT_MAP[body.result ?? "unknown"] ?? "unknown";
    const score = status === "valid" ? 97 : status === "catch_all" ? 60 : status === "risky" ? 30 : 10;
    return {
      status,
      deliverabilityScore: score,
      catchAll: status === "catch_all",
      risky: status === "risky",
    };
  }
}
