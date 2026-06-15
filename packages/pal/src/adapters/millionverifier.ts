import type { EmailVerification, EmailVerifier, EmailVerdict } from "../types.js";
import { fetchJson, qs } from "./http.js";

export const MILLIONVERIFIER_BASE_URL = "https://api.millionverifier.com/api/v3";

const RESULT_MAP: Record<string, EmailVerdict> = {
  ok: "valid",
  catch_all: "catch_all",
  unknown: "unknown",
  disposable: "risky",
  invalid: "invalid",
  error: "unknown",
};

/**
 * MillionVerifier — cheap bulk first-pass verification (strategy §5 / E4.1).
 * Docs: https://developer.millionverifier.com/
 * Key: MILLIONVERIFIER_API_KEY
 */
export class MillionVerifier implements EmailVerifier {
  readonly name = "millionverifier";
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = MILLIONVERIFIER_BASE_URL,
    private readonly timeoutMs?: number
  ) {}

  async verify(email: string): Promise<EmailVerification> {
    const url = `${this.baseUrl}/?${qs({ api: this.apiKey, email })}`;
    const body = await fetchJson<{ result?: string; quality?: string }>(url, {
      timeoutMs: this.timeoutMs,
    });
    const status = RESULT_MAP[body.result ?? "unknown"] ?? "unknown";
    const score = status === "valid" ? 95 : status === "catch_all" ? 60 : status === "risky" ? 40 : 10;
    return {
      status,
      deliverabilityScore: score,
      catchAll: status === "catch_all",
      risky: body.quality === "risky" || status === "risky",
    };
  }
}
