import type { EmailVerification, EmailVerifier, EmailVerdict } from "../types.js";
import { fetchJson, qs } from "./http.js";

export const ZEROBOUNCE_BASE_URL = "https://api.zerobounce.net/v2";

const STATUS_MAP: Record<string, EmailVerdict> = {
  valid: "valid",
  invalid: "invalid",
  "catch-all": "catch_all",
  spamtrap: "risky",
  abuse: "risky",
  do_not_mail: "risky",
  unknown: "unknown",
};

/**
 * ZeroBounce — accuracy gate verifier (strategy §5 / E4.2).
 * Docs: https://www.zerobounce.net/docs/email-validation-api-quickstart/
 * Key: ZEROBOUNCE_API_KEY
 */
export class ZeroBounce implements EmailVerifier {
  readonly name = "zerobounce";
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = ZEROBOUNCE_BASE_URL,
    private readonly timeoutMs?: number
  ) {}

  async verify(email: string): Promise<EmailVerification> {
    const url = `${this.baseUrl}/validate?${qs({ api_key: this.apiKey, email, ip_address: "" })}`;
    const body = await fetchJson<{ status?: string; sub_status?: string }>(url, {
      timeoutMs: this.timeoutMs,
    });
    const status = STATUS_MAP[body.status ?? "unknown"] ?? "unknown";
    const score = status === "valid" ? 98 : status === "catch_all" ? 60 : status === "risky" ? 30 : 10;
    return {
      status,
      deliverabilityScore: score,
      catchAll: status === "catch_all",
      risky: status === "risky",
    };
  }
}
