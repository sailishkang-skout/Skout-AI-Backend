import { isSyntheticCaptureDomain } from "../capture-domains.js";
import type {
  EmailFindContext,
  EmailFinder,
  FoundEmail,
  PhoneData,
  PhoneProvider,
} from "../types.js";
import { fetchJson } from "./http.js";

/**
 * Wiza — individual reveal (email / phone) for one person, identified by LinkedIn URL or
 * name + company. Reveals are asynchronous: POST creates one, then we poll GET until complete.
 * Docs: https://wiza.co/api-docs  (POST /api/individual_reveals, GET /api/individual_reveals/:id)
 * Key: WIZA_API_KEY (Bearer token). Each reveal is billed by Wiza, so it only runs on demand.
 */
export const WIZA_BASE_URL = "https://wiza.co";

type Json = Record<string, unknown>;
type Level = "partial" | "phone";

export interface WizaOptions {
  baseUrl?: string;
  timeoutMs?: number;
  /** Delay between status polls. */
  pollIntervalMs?: number;
  /** Give up waiting for a reveal to complete after this long. */
  maxWaitMs?: number;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

function firstPhone(d: Json): { mobile?: string; direct?: string } {
  const mobile = str(d.mobile_phone);
  const direct = str(d.phone_number);
  if (mobile || direct) return { mobile, direct };
  const phones = d.phones;
  if (Array.isArray(phones)) {
    for (const p of phones) {
      const v = typeof p === "string" ? str(p) : str((p as Json | undefined)?.number) ?? str((p as Json | undefined)?.pretty_number);
      if (v) return { mobile: v };
    }
  }
  return {};
}

class WizaReveal {
  private readonly baseUrl: string;
  private readonly timeoutMs?: number;
  private readonly pollIntervalMs: number;
  private readonly maxWaitMs: number;

  constructor(private readonly apiKey: string, opts: WizaOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? WIZA_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs;
    this.pollIntervalMs = opts.pollIntervalMs ?? 2000;
    this.maxWaitMs = opts.maxWaitMs ?? 45_000;
  }

  private headers() {
    return {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  /** Who to reveal: LinkedIn URL if known, otherwise name + company/domain. */
  private identify(fullName: string, domain: string, ctx?: { companyName?: string; linkedinUrl?: string }): Json | null {
    const profileUrl = str(ctx?.linkedinUrl);
    if (profileUrl) return { profile_url: profileUrl };
    const name = str(fullName);
    if (!name) return null;
    if (domain && !isSyntheticCaptureDomain(domain)) return { full_name: name, domain };
    const company = str(ctx?.companyName);
    return company ? { full_name: name, company } : null;
  }

  /** Create a reveal and wait for it. Returns the completed reveal's data, or null if nothing found. */
  async run(
    level: Level,
    fullName: string,
    domain: string,
    ctx?: { companyName?: string; linkedinUrl?: string }
  ): Promise<Json | null> {
    const who = this.identify(fullName, domain, ctx);
    if (!who) return null;

    const created = await fetchJson<Json>(`${this.baseUrl}/api/individual_reveals`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        individual_reveal: who,
        enrichment_level: level,
        email_options: { accept_work: true, accept_personal: true },
      }),
      timeoutMs: this.timeoutMs,
    });
    let data = (created.data as Json | undefined) ?? created;
    const id = data.id;
    if (id == null) return null;

    const deadline = Date.now() + this.maxWaitMs;
    while (!this.isDone(data)) {
      if (Date.now() >= deadline) throw new Error("Wiza reveal timed out before completing");
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
      const polled = await fetchJson<Json>(`${this.baseUrl}/api/individual_reveals/${encodeURIComponent(String(id))}`, {
        headers: this.headers(),
        timeoutMs: this.timeoutMs,
      });
      data = (polled.data as Json | undefined) ?? polled;
    }
    return String(data.status).toLowerCase() === "failed" ? null : data;
  }

  private isDone(d: Json): boolean {
    return d.is_complete === true || ["finished", "failed"].includes(String(d.status).toLowerCase());
  }
}

export class WizaEmailFinder implements EmailFinder {
  readonly name = "wiza";
  private readonly reveal: WizaReveal;
  constructor(apiKey: string, baseUrl?: string, timeoutMs?: number, opts: Omit<WizaOptions, "baseUrl" | "timeoutMs"> = {}) {
    this.reveal = new WizaReveal(apiKey, { baseUrl, timeoutMs, ...opts });
  }

  async findEmail(fullName: string, domain: string, context?: EmailFindContext): Promise<FoundEmail | null> {
    const d = await this.reveal.run("partial", fullName, domain, context);
    if (!d) return null;
    const email = str(d.email) ?? str((d.emails as Json[] | undefined)?.[0]?.email);
    if (!email) return null;
    const status = String(d.email_status ?? "").toLowerCase();
    if (status === "unfound") return null;
    return { email, confidence: status === "valid" ? 0.95 : status === "risky" ? 0.6 : 0.5 };
  }
}

export class WizaPhone implements PhoneProvider {
  readonly name = "wiza";
  private readonly reveal: WizaReveal;
  constructor(apiKey: string, baseUrl?: string, timeoutMs?: number, opts: Omit<WizaOptions, "baseUrl" | "timeoutMs"> = {}) {
    this.reveal = new WizaReveal(apiKey, { baseUrl, timeoutMs, ...opts });
  }

  async fetchPhone(fullName: string, domain: string, linkedinUrl?: string): Promise<PhoneData | null> {
    const d = await this.reveal.run("phone", fullName, domain, { linkedinUrl });
    if (!d) return null;
    const { mobile, direct } = firstPhone(d);
    if (!mobile && !direct) return null;
    return { ...(mobile ? { mobile } : {}), ...(direct ? { direct } : {}) };
  }
}
