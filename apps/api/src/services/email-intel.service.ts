import type { Env } from "../config/env.js";

/*
==================================================
EMAIL INTELLIGENCE SERVICE CLIENT
==================================================

Thin fetch wrapper around the internal Email
Intelligence service (SMTP-based verification,
pattern discovery/ranking) — reachable only inside
the VPC via CloudMap at EMAIL_INTEL_SERVICE_URL
(see infra/lib/stacks/email-intel-stack.ts).

Mirrors the AI_SERVICE_URL fetch pattern already used
in enrichment.routes.ts / suggest-reply.service.ts:
plain fetch, no new HTTP client dependency, upstream
failures surface as a typed error the route layer can
turn into a 502/503 rather than crashing the request.
==================================================
*/

export class EmailIntelUnavailableError extends Error {
  constructor(reason: string) {
    super(`Email Intelligence service unavailable: ${reason}`);
    this.name = "EmailIntelUnavailableError";
  }
}

/** Canonical status vocabulary — see verificationStatus.ts in the email-intel repo. */
export type EmailIntelStatus =
  | "VERIFIED"
  | "INVALID"
  | "CATCH_ALL"
  | "TEMPORARY"
  | "NO_MX"
  | "DNS_ERROR"
  | "SMTP_ERROR"
  | "UNKNOWN";

export interface EmailIntelVerifyResult {
  success: boolean;
  email: string;
  domain: string | null;
  disposable: boolean;
  verificationId?: string;
  verificationStatus?: { status: EmailIntelStatus; [key: string]: unknown };
  catchAll?: boolean;
  sendEligibility?: {
    allowed: boolean;
    decision: string;
    decisionConfidence: number; // 0-100
    [key: string]: unknown;
  };
  error?: string;
  [key: string]: unknown;
}

export interface EmailIntelBatchResult {
  success: boolean;
  count: number;
  results: EmailIntelVerifyResult[];
}

export interface EmailIntelDiscoveryResult {
  success: boolean;
  [key: string]: unknown;
}

export interface EmailIntelPatternResult {
  success: boolean;
  [key: string]: unknown;
}

function baseUrl(config: Pick<Env, "EMAIL_INTEL_SERVICE_URL">): string | null {
  const url = config.EMAIL_INTEL_SERVICE_URL?.trim();
  if (!url) return null;
  return url.replace(/\/$/, "");
}

export function isEmailIntelConfigured(config: Pick<Env, "EMAIL_INTEL_SERVICE_URL">): boolean {
  return baseUrl(config) !== null;
}

async function post<T>(
  config: Pick<Env, "EMAIL_INTEL_SERVICE_URL" | "EMAIL_INTEL_TIMEOUT_MS">,
  path: string,
  body: unknown
): Promise<T> {
  const url = baseUrl(config);
  if (!url) {
    throw new EmailIntelUnavailableError("EMAIL_INTEL_SERVICE_URL is not configured");
  }

  let res: Response;
  try {
    res = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.EMAIL_INTEL_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    throw new EmailIntelUnavailableError(err instanceof Error ? err.message : String(err));
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new EmailIntelUnavailableError(`upstream ${res.status}: ${text.slice(0, 300)}`);
  }

  return (await res.json()) as T;
}

/** POST /verify — single-email SMTP-based verification. */
export function verifyEmail(
  config: Pick<Env, "EMAIL_INTEL_SERVICE_URL" | "EMAIL_INTEL_TIMEOUT_MS">,
  email: string
): Promise<EmailIntelVerifyResult> {
  return post(config, "/verify", { email });
}

/*
==================================================
PAL-COMPATIBLE ADAPTER
==================================================

Maps the email-intel service's richer 8-state status
(see EmailIntelStatus above) onto @skout/pal's simpler
5-state EmailVerdict, so it can be dropped in ahead of
the existing ZeroBounce/NeverBounce/MillionVerifier
waterfall in resolveEmailVerifier() without that
caller needing to know which provider answered.

deliverabilityScore comes straight from the service's
own sendEligibility.decisionConfidence (0-100) rather
than a guessed constant — it's already the tool's
policy-engine confidence in this exact result.
==================================================
*/

export interface EmailIntelVerdict {
  status: "valid" | "invalid" | "catch_all" | "risky" | "unknown";
  deliverabilityScore: number;
  catchAll: boolean;
  risky: boolean;
}

const STATUS_TO_VERDICT: Record<EmailIntelStatus, EmailIntelVerdict["status"]> = {
  VERIFIED: "valid",
  INVALID: "invalid",
  CATCH_ALL: "catch_all",
  TEMPORARY: "unknown",
  NO_MX: "unknown",
  DNS_ERROR: "unknown",
  SMTP_ERROR: "unknown",
  UNKNOWN: "unknown",
};

/**
 * POST /verify, then adapt into the same shape resolveEmailVerifier()'s
 * PAL providers return. Returns null (never throws) when the service is
 * unreachable/unconfigured or the response can't be interpreted — callers
 * fall back to the existing PAL waterfall in that case.
 */
export async function verifyEmailAsVerdict(
  config: Pick<Env, "EMAIL_INTEL_SERVICE_URL" | "EMAIL_INTEL_TIMEOUT_MS">,
  email: string
): Promise<EmailIntelVerdict | null> {
  let result: EmailIntelVerifyResult;
  try {
    result = await verifyEmail(config, email);
  } catch {
    return null;
  }

  const status = result.verificationStatus?.status;
  if (!result.success || !status) return null;

  const verdict = STATUS_TO_VERDICT[status] ?? "unknown";
  const confidence = result.sendEligibility?.decisionConfidence;

  return {
    status: verdict,
    deliverabilityScore: typeof confidence === "number" ? confidence : verdict === "valid" ? 90 : 0,
    catchAll: result.catchAll ?? verdict === "catch_all",
    risky: verdict === "catch_all" || verdict === "unknown",
  };
}

export interface SendEligibilityCheck {
  /** True = OK to send. False = the policy engine says don't (or defer/review) — caller should block the send. */
  allowed: boolean;
  decision: string;
  reason?: string;
  decisionConfidence?: number;
}

/**
 * POST /verify, then extract just the send-eligibility gate — the policy decision (SAFE vs.
 * catch-all/pattern-risk/etc.), not the raw mailbox-existence verdict `verifyEmailAsVerdict`
 * returns. This is deliberately more conservative than `EmailVerdict.status === "valid"`: e.g.
 * catch-all domains are `sendable` in Skout's own SENDABLE_STATUSES today, but the email-intel
 * policy engine never marks catch-all `allowed` — it always requires manual review.
 *
 * Fails OPEN (returns `allowed: true`) when the service is unconfigured or unreachable, same
 * as `verifyEmailAsVerdict` — this is a safety *enhancement* layered on top of the existing
 * suppression-list gate, not a replacement for it, so its own unavailability must never block
 * sending outright.
 */
export async function checkSendEligibility(
  config: Pick<Env, "EMAIL_INTEL_SERVICE_URL" | "EMAIL_INTEL_TIMEOUT_MS">,
  email: string
): Promise<SendEligibilityCheck> {
  if (!isEmailIntelConfigured(config)) return { allowed: true, decision: "NOT_CONFIGURED" };

  let result: EmailIntelVerifyResult;
  try {
    result = await verifyEmail(config, email);
  } catch {
    return { allowed: true, decision: "UNAVAILABLE" };
  }

  const eligibility = result.sendEligibility;
  if (!result.success || !eligibility) return { allowed: true, decision: "NO_DECISION" };

  return {
    allowed: eligibility.allowed,
    decision: eligibility.decision,
    reason: typeof eligibility.reason === "string" ? eligibility.reason : undefined,
    decisionConfidence: eligibility.decisionConfidence,
  };
}

/** POST /verify/batch — synchronous bounded batch (caller waits for all results). */
export function verifyEmailBatch(
  config: Pick<Env, "EMAIL_INTEL_SERVICE_URL" | "EMAIL_INTEL_TIMEOUT_MS">,
  emails: string[]
): Promise<EmailIntelBatchResult> {
  return post(config, "/verify/batch", { emails });
}

/** POST /email-discovery — guesses + verifies the most likely email for a name + domain. */
export function discoverEmail(
  config: Pick<Env, "EMAIL_INTEL_SERVICE_URL" | "EMAIL_INTEL_TIMEOUT_MS">,
  params: { firstName: string; lastName?: string; domain: string; maxVerifications?: number; verify?: boolean }
): Promise<EmailIntelDiscoveryResult> {
  return post(config, "/email-discovery", params);
}

/** POST /patterns — ranks likely email patterns for a domain from observed evidence. */
export function generatePatterns(
  config: Pick<Env, "EMAIL_INTEL_SERVICE_URL" | "EMAIL_INTEL_TIMEOUT_MS">,
  params: { firstName: string; lastName: string; domain: string }
): Promise<EmailIntelPatternResult> {
  return post(config, "/patterns", {
    first_name: params.firstName,
    last_name: params.lastName,
    domain: params.domain,
  });
}
