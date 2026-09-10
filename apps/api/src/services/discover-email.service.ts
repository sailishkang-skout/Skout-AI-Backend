import { promises as dns } from "node:dns";
import { normalizeDomain } from "@skout/shared";
import { generateEmailCandidates, HunterEmailFinder, HunterEmailVerifier, isLiveApiKey } from "@skout/pal";
import type { EmailVerdict } from "@skout/pal";
import type { Env } from "../config/env.js";
import { HttpError } from "../utils/http.js";
import {
  discoverEmail,
  EmailIntelUnavailableError,
  type EmailIntelDiscoveryResult,
  isEmailIntelConfigured,
} from "./email-intel.service.js";

const DOMAIN_FORMAT = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const MAX_PATTERN_VERIFICATIONS = 5;

export interface DiscoverEmailParams {
  firstName: string;
  lastName?: string;
  domain: string;
  maxVerifications?: number;
  verify?: boolean;
}

function hunterFromConfig(config: Env): { finder: HunterEmailFinder; verifier: HunterEmailVerifier } | null {
  if (!isLiveApiKey(config.HUNTER_API_KEY)) return null;
  return {
    finder: new HunterEmailFinder(config.HUNTER_API_KEY!, config.HUNTER_BASE_URL, config.ENRICHMENT_REQUEST_TIMEOUT_MS),
    verifier: new HunterEmailVerifier(config.HUNTER_API_KEY!, config.HUNTER_BASE_URL, config.ENRICHMENT_REQUEST_TIMEOUT_MS),
  };
}

export function normalizeDiscoverDomain(raw: string): string {
  return normalizeDomain(raw);
}

export function assertDiscoverDomain(domain: string): string {
  const normalized = normalizeDiscoverDomain(domain);
  if (!normalized) {
    throw new HttpError("invalid_domain", 400, "Enter a company domain (e.g. microsoft.com).");
  }
  if (!DOMAIN_FORMAT.test(normalized)) {
    throw new HttpError("invalid_domain", 400, "Domain format is invalid.");
  }
  return normalized;
}

export async function assertDomainHasMx(domain: string): Promise<void> {
  try {
    const records = await dns.resolveMx(domain);
    if (records.length > 0) return;
  } catch {
    // fall through
  }
  throw new HttpError(
    "domain_no_mx",
    422,
    `No mail records (MX) found for ${domain}. Check the spelling or use the company's primary email domain.`
  );
}

function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).toLowerCase() : "";
}

function assertEmailMatchesDomain(email: string, domain: string): void {
  if (emailDomain(email) !== domain) {
    throw new HttpError(
      "domain_mismatch",
      422,
      `Discovered email ${email} does not belong to ${domain}.`
    );
  }
}

function verdictToDecision(status: EmailVerdict): string {
  switch (status) {
    case "valid":
      return "STRONG";
    case "catch_all":
      return "GOOD";
    case "risky":
      return "REVIEW";
    case "invalid":
      return "REJECT";
    default:
      return "WEAK";
  }
}

function verdictToConfidence(status: EmailVerdict, score: number): number {
  if (status === "valid") return Math.max(score, 85);
  if (status === "catch_all") return Math.max(score, 65);
  if (status === "risky") return Math.max(score, 45);
  if (status === "invalid") return Math.min(score, 15);
  return Math.max(score, 35);
}

function inferPattern(email: string, firstName: string, lastName: string | undefined): string {
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  const first = firstName.trim().toLowerCase().replace(/[^a-z]/g, "");
  const last = (lastName ?? "").trim().toLowerCase().replace(/[^a-z]/g, "");
  if (last && local === `${first}.${last}`) return "first.last";
  if (last && local === `${first}${last}`) return "firstlast";
  if (last && local === `${first[0]}${last}`) return "flast";
  if (local === first) return "first";
  return "pattern";
}

export function hasDiscoverFallback(config: Env): boolean {
  return isLiveApiKey(config.HUNTER_API_KEY);
}

export async function discoverEmailResolved(
  config: Env,
  params: DiscoverEmailParams
): Promise<EmailIntelDiscoveryResult> {
  const domain = assertDiscoverDomain(params.domain);
  await assertDomainHasMx(domain);

  const payload = {
    firstName: params.firstName.trim(),
    lastName: params.lastName?.trim() || undefined,
    domain,
    maxVerifications: params.maxVerifications,
    verify: params.verify,
  };

  if (isEmailIntelConfigured(config)) {
    try {
      const upstream = await discoverEmail(config, payload);
      return sanitizeDiscoveryResult(upstream, domain);
    } catch (err) {
      if (err instanceof EmailIntelUnavailableError && err.upstreamStatus != null && err.upstreamStatus >= 400 && err.upstreamStatus < 500) {
        throw new HttpError("email_intel_rejected", err.upstreamStatus, err.upstreamBody);
      }
      if (hasDiscoverFallback(config)) {
        return discoverEmailWithHunter(config, payload);
      }
      throw err;
    }
  }

  if (hasDiscoverFallback(config)) {
    return discoverEmailWithHunter(config, payload);
  }

  throw new HttpError(
    "email_intel_not_configured",
    503,
    "Email discovery requires EMAIL_INTEL_SERVICE_URL or HUNTER_API_KEY."
  );
}

function sanitizeDiscoveryResult(result: EmailIntelDiscoveryResult, domain: string): EmailIntelDiscoveryResult {
  const candidates = (result.candidates ?? []).filter((candidate) => emailDomain(candidate.email) === domain);
  const recommendedEmail =
    result.recommendedEmail && emailDomain(result.recommendedEmail) === domain
      ? result.recommendedEmail
      : (candidates.find((c) => c.decision === "STRONG" || c.decision === "GOOD")?.email ?? candidates[0]?.email ?? null);

  return {
    ...result,
    domain,
    recommendedEmail,
    recommendedPattern: recommendedEmail
      ? candidates.find((c) => c.email === recommendedEmail)?.pattern ?? result.recommendedPattern
      : null,
    recommendedConfidence: recommendedEmail
      ? candidates.find((c) => c.email === recommendedEmail)?.confidence ?? result.recommendedConfidence
      : null,
    candidates,
  };
}

async function discoverEmailWithHunter(
  config: Env,
  params: { firstName: string; lastName?: string; domain: string; maxVerifications?: number; verify?: boolean }
): Promise<EmailIntelDiscoveryResult> {
  const hunter = hunterFromConfig(config);
  if (!hunter) {
    throw new HttpError("discover_unavailable", 503, "No email discovery providers are configured.");
  }

  const fullName = params.lastName ? `${params.firstName} ${params.lastName}` : params.firstName;
  const verify = params.verify !== false;
  const maxChecks = Math.min(params.maxVerifications ?? MAX_PATTERN_VERIFICATIONS, MAX_PATTERN_VERIFICATIONS);

  type Candidate = NonNullable<EmailIntelDiscoveryResult["candidates"]>[number];
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  const pushCandidate = (candidate: Candidate) => {
    if (seen.has(candidate.email)) return;
    seen.add(candidate.email);
    candidates.push(candidate);
  };

  const found = await hunter.finder.findEmail(fullName, params.domain);
  if (found?.email) {
    assertEmailMatchesDomain(found.email, params.domain);
    if (verify) {
      const verdict = await hunter.verifier.verify(found.email);
      pushCandidate({
        email: found.email,
        pattern: "hunter",
        finalScore: Math.round((found.confidence ?? verdict.deliverabilityScore / 100) * 100),
        decision: verdictToDecision(verdict.status),
        confidence: verdictToConfidence(verdict.status, verdict.deliverabilityScore),
        reasons: ["Hunter email finder"],
      });
    } else {
      pushCandidate({
        email: found.email,
        pattern: "hunter",
        finalScore: Math.round((found.confidence ?? 0.7) * 100),
        decision: "GOOD",
        confidence: Math.round((found.confidence ?? 0.7) * 100),
        reasons: ["Hunter email finder (unverified)"],
      });
    }
  }

  if (verify) {
    const generated = generateEmailCandidates(fullName, params.domain).slice(0, maxChecks);
    for (const email of generated) {
      if (seen.has(email)) continue;
      const verdict = await hunter.verifier.verify(email);
      if (verdict.status === "invalid") continue;
      pushCandidate({
        email,
        pattern: inferPattern(email, params.firstName, params.lastName),
        finalScore: verdictToConfidence(verdict.status, verdict.deliverabilityScore),
        decision: verdictToDecision(verdict.status),
        confidence: verdictToConfidence(verdict.status, verdict.deliverabilityScore),
        reasons: ["Pattern generation + Hunter verification"],
      });
    }
  }

  candidates.sort((a, b) => b.confidence - a.confidence);
  const recommended = candidates.find((c) => c.decision === "STRONG" || c.decision === "GOOD") ?? candidates[0];

  return {
    success: true,
    firstName: params.firstName,
    lastName: params.lastName ?? null,
    domain: params.domain,
    recommendedEmail: recommended?.email ?? null,
    recommendedPattern: recommended?.pattern ?? null,
    recommendedConfidence: recommended?.confidence ?? null,
    candidates,
    provider: "hunter-fallback",
  };
}
