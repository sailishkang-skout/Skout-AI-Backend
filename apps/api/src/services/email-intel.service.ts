import type { Env } from "../config/env.js";
import { HunterEmailVerifier, isLiveApiKey } from "@skout/pal";
import { suggestDomainCorrection } from "../utils/domain-typo.js";

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
  readonly upstreamStatus?: number;
  readonly upstreamBody?: unknown;

  constructor(reason: string, upstreamStatus?: number, upstreamBody?: unknown) {
    super(`Email Intelligence service unavailable: ${reason}`);
    this.name = "EmailIntelUnavailableError";
    this.upstreamStatus = upstreamStatus;
    this.upstreamBody = upstreamBody;
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
  /** Set when the domain looks like a typo of a common domain (see applyDomainTypoCheck). */
  suggestedDomain?: string;
  error?: string;
  [key: string]: unknown;
}

export interface EmailIntelBatchResult {
  success: boolean;
  count: number;
  results: EmailIntelVerifyResult[];
}

export interface EmailIntelDiscoveryCandidate {
  email: string;
  pattern: string;
  finalScore: number;
  decision: string;
  confidence: number;
  reasons: string[];
}

export interface EmailIntelDiscoveryResult {
  success: boolean;
  firstName?: string;
  lastName?: string | null;
  domain?: string;
  recommendedEmail?: string | null;
  recommendedPattern?: string | null;
  recommendedConfidence?: number | null;
  candidates?: EmailIntelDiscoveryCandidate[];
  provider?: string;
  error?: string;
  [key: string]: unknown;
}

export interface EmailIntelPatternResult {
  success: boolean;
  [key: string]: unknown;
}

/**
 * @deprecated Shape of the upstream email-intel service's warmup responses.
 *
 * NOTE: as of writing, `src/services/warmup/` in the email-intel repo is a
 * deliberate scaffold (its own docs/EXTERNAL.md: "Warmup ... scaffold only,
 * not sending mail yet") — every warmup function there except the status
 * read unconditionally throws "not implemented", which its POST /warmup/start
 * route surfaces as upstream 501. This proxy's `post()`/`get()` helpers treat
 * any non-2xx upstream response as EmailIntelUnavailableError (mapped to 502
 * below), matching how the existing verify/discover/patterns proxies already
 * treat upstream non-2xx — so today `startWarmup` will reliably reject with
 * EmailIntelUnavailableError until the upstream engine is implemented.
 * `getWarmupStatus` does succeed today, but only reports the scaffold-wide
 * `{ enabled: false, phase: "scaffold" }` state, not real per-domain progress.
 *
 * A grep confirmed zero real callers of this proxy path (the real, active warmup
 * lifecycle lives in Warm-Up-Tool — see warmup-ramp.worker.ts). Kept deprecated
 * rather than deleted pending explicit maintainer sign-off on removal.
 */
export interface EmailIntelWarmupStartResult {
  success: boolean;
  domain: string;
  mailbox: string | null;
  status?: string;
  [key: string]: unknown;
}

/** @deprecated see EmailIntelWarmupStartResult */
export interface EmailIntelWarmupStatusResult {
  success: boolean;
  domain: string;
  enabled: boolean;
  phase: string;
  score: number | null;
  dayInProgram: number | null;
  [key: string]: unknown;
}



function baseUrl(config: Pick<Env, "EMAIL_INTEL_SERVICE_URL">): string | null {
  if (!config.EMAIL_INTEL_SERVICE_URL) return null;
  // Ensure base URL has a trailing slash to avoid path concatenation issues
  return config.EMAIL_INTEL_SERVICE_URL.endsWith("/") 
    ? config.EMAIL_INTEL_SERVICE_URL 
    : `${config.EMAIL_INTEL_SERVICE_URL}/`;
}

export function isEmailIntelConfigured(config: Pick<Env, "EMAIL_INTEL_SERVICE_URL">): boolean {
  return baseUrl(config) !== null;
}

function parseUpstreamBody(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text.slice(0, 300);
  }
}

type EmailIntelConfig = Pick<Env, "EMAIL_INTEL_SERVICE_URL" | "EMAIL_INTEL_TIMEOUT_MS"> & { EMAIL_INTEL_DISCOVER_TIMEOUT_MS?: number };

function requestTimeoutMs(config: EmailIntelConfig, path: string): number {
  if (path === "/discover" || path === "/verify/batch") {
    return config.EMAIL_INTEL_DISCOVER_TIMEOUT_MS ?? config.EMAIL_INTEL_TIMEOUT_MS;
  }
  return config.EMAIL_INTEL_TIMEOUT_MS;
}

async function post<T>(
  config: EmailIntelConfig,
  path: string,
  body: unknown
): Promise<T> {
  const url = baseUrl(config);
  if (!url) {
    throw new EmailIntelUnavailableError("EMAIL_INTEL_SERVICE_URL is not configured");
  }

  let res: Response;
  try {
    // Remove leading slash from path to avoid double slashes in URL
    const cleanPath = path.startsWith("/") ? path.slice(1) : path;
    res = await fetch(`${url}${cleanPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(requestTimeoutMs(config, path)),
    });
  } catch (err: unknown) {
    throw new EmailIntelUnavailableError(err instanceof Error ? err.message : String(err));
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new EmailIntelUnavailableError(`upstream ${res.status}: ${text.slice(0, 300)}`, res.status, parseUpstreamBody(text));
  }

  return (await res.json()) as T;
}

/** @deprecated only used by the deprecated getWarmupStatus below. */
async function get<T>(
  config: EmailIntelConfig,
  path: string,
  query: Record<string, string>
): Promise<T> {
  const url = baseUrl(config);
  if (!url) {
    throw new EmailIntelUnavailableError("EMAIL_INTEL_SERVICE_URL is not configured");
  }

  const qs = new URLSearchParams(query).toString();

  let res: Response;
  try {
    // Remove leading slash from path to avoid double slashes in URL
    const cleanPath = path.startsWith("/") ? path.slice(1) : path;
    res = await fetch(`${url}${cleanPath}?${qs}`, {
      method: "GET",
      signal: AbortSignal.timeout(config.EMAIL_INTEL_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    throw new EmailIntelUnavailableError(err instanceof Error ? err.message : String(err));
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new EmailIntelUnavailableError(`upstream ${res.status}: ${text.slice(0, 300)}`, res.status, parseUpstreamBody(text));
  }

  return (await res.json()) as T;
}

/** Raw upstream statuses ambiguous enough that an obvious domain typo should win over them. */
const TYPO_ELIGIBLE_STATUSES: ReadonlySet<EmailIntelStatus> = new Set(["UNKNOWN", "NO_MX", "DNS_ERROR"]);

/**
 * When the upstream verdict is ambiguous (UNKNOWN/NO_MX/DNS_ERROR) and the domain is an obvious
 * typo of a common domain (e.g. "gmail.com"), override the verdict to INVALID with a
 * suggestedDomain instead of surfacing an unexplained ambiguous result.
 */
function applyDomainTypoCheck(result: EmailIntelVerifyResult): EmailIntelVerifyResult {
  const status = result.verificationStatus?.status;
  if (!status || !TYPO_ELIGIBLE_STATUSES.has(status)) return result;
  if (!result.domain) return result;

  const suggestedDomain = suggestDomainCorrection(result.domain);
  if (!suggestedDomain) return result;

  return {
    ...result,
    verificationStatus: { ...result.verificationStatus, status: "INVALID" },
    suggestedDomain,
    sendEligibility: result.sendEligibility
      ? { ...result.sendEligibility, allowed: false, decision: "INVALID_TYPO" }
      : result.sendEligibility,
  };
}

/** POST /verify — single-email SMTP-based verification. */
export async function verifyEmail(
  config: Pick<Env, "EMAIL_INTEL_SERVICE_URL" | "EMAIL_INTEL_TIMEOUT_MS">,
  email: string
): Promise<EmailIntelVerifyResult> {
  const result = await post<EmailIntelVerifyResult>(config, "/verify", { email });
  return applyDomainTypoCheck(result);
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
  config: EmailIntelConfig,
  emails: string[]
): Promise<EmailIntelBatchResult> {
  return post(config, "/verify/batch", { emails });
}

/** POST /discover — guesses + verifies the most likely email for a name + domain. */
export function discoverEmail(
  config: Pick<Env, "EMAIL_INTEL_SERVICE_URL" | "EMAIL_INTEL_TIMEOUT_MS">,
  params: { firstName: string; lastName?: string; domain: string; maxVerifications?: number; verify?: boolean }
): Promise<EmailIntelDiscoveryResult> {
  return post(config, "/discover", params);
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

/**
 * @deprecated POST /warmup/start — zero real callers (grep-confirmed); the real, active
 * warmup lifecycle lives in Warm-Up-Tool (warmup-ramp.worker.ts). Kept, not deleted,
 * pending explicit maintainer sign-off — see EmailIntelWarmupStartResult above.
 */
export function startWarmup(
  config: Pick<Env, "EMAIL_INTEL_SERVICE_URL" | "EMAIL_INTEL_TIMEOUT_MS">,
  params: { domain: string; mailbox?: string }
): Promise<EmailIntelWarmupStartResult> {
  return post(config, "/warmup/start", params);
}

/** @deprecated GET /warmup/status?domain=... — see startWarmup above. */
export function getWarmupStatus(
  config: Pick<Env, "EMAIL_INTEL_SERVICE_URL" | "EMAIL_INTEL_TIMEOUT_MS">,
  domain: string
): Promise<EmailIntelWarmupStatusResult> {
  return get(config, "/warmup/status", { domain });
}

const VERDICT_TO_INTEL: Record<string, EmailIntelStatus> = {
  valid: "VERIFIED",
  invalid: "INVALID",
  catch_all: "CATCH_ALL",
  risky: "UNKNOWN",
  unknown: "UNKNOWN",
};

function hunterVerifier(config: Pick<Env, "HUNTER_API_KEY" | "HUNTER_BASE_URL" | "ENRICHMENT_REQUEST_TIMEOUT_MS">) {
  if (!isLiveApiKey(config.HUNTER_API_KEY)) return null;
  return new HunterEmailVerifier(config.HUNTER_API_KEY!, config.HUNTER_BASE_URL, config.ENRICHMENT_REQUEST_TIMEOUT_MS);
}

function hunterVerifyResult(email: string, verdictStatus: string, score: number, catchAll: boolean): EmailIntelVerifyResult {
  const status = VERDICT_TO_INTEL[verdictStatus] ?? "UNKNOWN";
  const allowed = status === "VERIFIED";
  return {
    success: true,
    email,
    domain: email.includes("@") ? email.split("@")[1]!.toLowerCase() : null,
    disposable: verdictStatus === "disposable",
    verificationStatus: { status },
    catchAll,
    sendEligibility: {
      allowed,
      decision: allowed ? "SAFE" : catchAll ? "MANUAL_REVIEW" : "REVIEW",
      decisionConfidence: score,
      reason:
        status === "UNKNOWN" && verdictStatus === "webmail"
          ? "Webmail provider — SMTP verification unavailable; Hunter verdict used."
          : undefined,
    },
    provider: "hunter-fallback",
  };
}

/**
 * Verify via email-intel when configured. On SMTP_ERROR/UNAVAILABLE or upstream failure,
 * fall back to Hunter (handles Gmail/webmail where port-25 SMTP checks fail).
 */
export async function verifyEmailResolved(
  config: Pick<
    Env,
    | "EMAIL_INTEL_SERVICE_URL"
    | "EMAIL_INTEL_TIMEOUT_MS"
    | "HUNTER_API_KEY"
    | "HUNTER_BASE_URL"
    | "ENRICHMENT_REQUEST_TIMEOUT_MS"
  >,
  email: string
): Promise<EmailIntelVerifyResult> {
  const normalized = email.trim().toLowerCase();
  const hunter = hunterVerifier(config);

  if (isEmailIntelConfigured(config)) {
    try {
      const result = await verifyEmail(config, normalized);
      const status = result.verificationStatus?.status;
      if (
        status &&
        status !== "SMTP_ERROR" &&
        status !== "DNS_ERROR" &&
        status !== "NO_MX" &&
        result.success
      ) {
        return result;
      }
      if (hunter) {
        const verdict = await hunter.verify(normalized);
        return applyDomainTypoCheck(
          hunterVerifyResult(normalized, verdict.status, verdict.deliverabilityScore, verdict.catchAll)
        );
      }
      return result;
    } catch (err) {
      if (hunter) {
        const verdict = await hunter.verify(normalized);
        return applyDomainTypoCheck(
          hunterVerifyResult(normalized, verdict.status, verdict.deliverabilityScore, verdict.catchAll)
        );
      }
      throw err;
    }
  }

  if (hunter) {
    const verdict = await hunter.verify(normalized);
    return applyDomainTypoCheck(
      hunterVerifyResult(normalized, verdict.status, verdict.deliverabilityScore, verdict.catchAll)
    );
  }

  // Local mock verification for development (no external services required)
  const domain = normalized.split("@")[1] || "example.com";
  const isDisposable = ["tempmail.com", "10minutemail.com"].includes(domain);
  const isWebmail = ["gmail.com", "yahoo.com", "outlook.com", "icloud.com"].includes(domain);
  
  return applyDomainTypoCheck({
    success: true,
    email: normalized,
    domain,
    disposable: isDisposable,
    verificationStatus: { status: isDisposable ? "INVALID" : "VERIFIED" },
    catchAll: false,
    sendEligibility: {
      allowed: !isDisposable,
      decision: isDisposable ? "REVIEW" : "SAFE",
      decisionConfidence: isWebmail ? 85 : 95,
      reason: isWebmail 
        ? "Webmail provider — local mock verification passed." 
        : "Local mock verification passed.",
    },
    provider: "local-mock",
  });
}