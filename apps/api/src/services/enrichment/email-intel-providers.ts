// cSpell:ignore skout
import { isSyntheticCaptureDomain, splitName } from "@skout/pal";
import type {
  EmailFindContext,
  EmailFinder,
  EmailVerification,
  EmailVerifier,
  FoundEmail,
  ProviderRegistry,
} from "@skout/pal";
import type { Env } from "../../config/env.js";
import {
  discoverEmail,
  isEmailIntelConfigured,
  verifyEmail,
  type EmailIntelStatus,
} from "../email-intel.service.js";

/*
 * Plugs our own Email Intelligence service into the enrichment engine's provider waterfall.
 *
 * Before this, /prospects/:id/enrich only ever called Hunter / MillionVerifier / etc.; the
 * email-intel service was reachable only from the list-verify and verify-email endpoints.
 *
 * Both adapters THROW when email-intel cannot give a conclusive answer. The engine records a
 * throw as an "error" attempt and moves on to the next provider — which is exactly what we want
 * (the engine stops at the first provider that returns a value, so a non-answer must not be one).
 */

type EmailIntelConfig = Pick<
  Env,
  "EMAIL_INTEL_SERVICE_URL" | "EMAIL_INTEL_TIMEOUT_MS" | "EMAIL_INTEL_DISCOVER_TIMEOUT_MS"
>;

/** The SMTP/DNS check itself failed (e.g. Gmail blocks port 25) — says nothing about the mailbox. */
const INCONCLUSIVE: ReadonlySet<EmailIntelStatus> = new Set(["SMTP_ERROR", "DNS_ERROR", "NO_MX"]);

const VERDICT: Record<EmailIntelStatus, EmailVerification["status"]> = {
  VERIFIED: "valid",
  INVALID: "invalid",
  CATCH_ALL: "catch_all",
  TEMPORARY: "unknown",
  NO_MX: "unknown",
  DNS_ERROR: "unknown",
  SMTP_ERROR: "unknown",
  UNKNOWN: "unknown",
};

export class EmailIntelVerifier implements EmailVerifier {
  readonly name = "email-intel";
  constructor(private readonly config: EmailIntelConfig) {}

  async verify(email: string): Promise<EmailVerification> {
    const result = await verifyEmail(this.config, email.trim().toLowerCase());
    const status = result.verificationStatus?.status;
    if (!result.success || !status) throw new Error("email-intel returned no verdict");
    if (INCONCLUSIVE.has(status)) throw new Error(`email-intel inconclusive (${status})`);

    const verdict = VERDICT[status] ?? "unknown";
    const confidence = result.sendEligibility?.decisionConfidence;
    return {
      status: verdict,
      deliverabilityScore: typeof confidence === "number" ? confidence : verdict === "valid" ? 90 : 0,
      catchAll: result.catchAll ?? verdict === "catch_all",
      risky: verdict === "catch_all" || verdict === "unknown",
    };
  }
}

/** Only candidates the service itself rates as verified-quality are worth returning as "found". */
const ACCEPTED_DECISIONS: ReadonlySet<string> = new Set(["STRONG", "GOOD"]);

function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

export class EmailIntelFinder implements EmailFinder {
  readonly name = "email-intel";
  constructor(private readonly config: EmailIntelConfig) {}

  async findEmail(fullName: string, domain: string, _context?: EmailFindContext): Promise<FoundEmail | null> {
    // Discovery needs a real mail domain; LinkedIn-only prospects (placeholder domain) go to the
    // providers that can resolve by profile URL or company name.
    const d = domain.trim().toLowerCase();
    if (!d || isSyntheticCaptureDomain(d)) return null;
    const { first, last } = splitName(fullName.trim());
    if (!first) return null;

    const res = await discoverEmail(this.config, {
      firstName: first,
      lastName: last || undefined,
      domain: d,
      verify: true,
    });
    if (!res.success) return null;

    const candidates = (res.candidates ?? []).filter((c) => emailDomain(c.email) === d);
    const recommended =
      res.recommendedEmail && emailDomain(res.recommendedEmail) === d ? res.recommendedEmail : undefined;
    const best =
      candidates.find((c) => c.email === recommended && ACCEPTED_DECISIONS.has(c.decision)) ??
      candidates.find((c) => ACCEPTED_DECISIONS.has(c.decision));
    if (!best) return null;

    // email-intel confidence is 0-100; PAL finders report 0-1.
    return { email: best.email, confidence: Math.max(0, Math.min(1, best.confidence / 100)) };
  }
}

/**
 * Put email-intel first in the engine's finder and verifier waterfalls when it is configured.
 * Mutates and returns the registry. Existing providers stay behind it as fallbacks.
 */
export function withEmailIntel(registry: ProviderRegistry, config: Env): ProviderRegistry {
  if (!isEmailIntelConfigured(config)) return registry;
  registry.emailFinders.unshift(new EmailIntelFinder(config));
  registry.emailVerifiers.unshift(new EmailIntelVerifier(config));
  return registry;
}
