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

export interface EmailIntelVerifyResult {
  success: boolean;
  email: string;
  domain: string | null;
  disposable: boolean;
  status?: string;
  deliverabilityScore?: number;
  catchAll?: boolean;
  risky?: boolean;
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
