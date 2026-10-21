import { resolveAutomationSecret } from "../automation-secrets.service.js";
import { AmbiguousOutcomeError } from "./types.js";
import { HttpError } from "../../utils/http.js";
import type { NodeHandler } from "./types.js";

/**
 * Config: { url: string; method?: string; headers?: Record<string,string>; body?: unknown;
 * credentialId?: string; credentialHeaderName?: string }. When credentialId is set, the resolved
 * secret is attached as a header (default "Authorization") — never logged or included in output.
 */
const PRIVATE_HOST = [
  /^localhost$/i,
  /\.(local|localhost|internal|lan|home|corp)$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^\[?(::1?|f[cd][0-9a-f]{2}:|fe80:)/i,
];

/**
 * COPS-10: "call integration" (Bible p.68), not arbitrary networking. The URL must be https and
 * not name a loopback, private, link-local or internal host. Returns the problem, or null.
 * (A public name that resolves to a private address is not caught here.)
 */
export function publicHttpsUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "The URL is not valid";
  }
  if (url.protocol !== "https:") return "The URL must use https";
  if (url.username || url.password) return "The URL cannot carry a user name or password";
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || PRIVATE_HOST.some((re) => re.test(host))) return "The URL cannot point to a private or internal host";
  return null;
}

export const httpActionNodeHandler: NodeHandler = async (ctx) => {
  const { url, method = "GET", headers, body, credentialId, credentialHeaderName } = ctx.node.config as {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    credentialId?: string;
    credentialHeaderName?: string;
  };

  const problem = publicHttpsUrlProblem(url);
  if (problem) throw new HttpError(problem, 422);

  if (ctx.isSimulation) {
    return { output: { simulated: true, url, method } };
  }

  // The step's key lets an integration that honours Idempotency-Key drop a retried call.
  const resolvedHeaders: Record<string, string> = { ...(ctx.stepKey ? { "Idempotency-Key": ctx.stepKey } : {}), ...headers };
  if (credentialId) {
    const secretValue = await resolveAutomationSecret(ctx.db, ctx.config, ctx.workspaceId, credentialId);
    resolvedHeaders[credentialHeaderName ?? "Authorization"] = secretValue;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { "content-type": "application/json", ...resolvedHeaders },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // A network/timeout error after the request may have already reached the receiving end —
    // this generic HTTP node has no idempotency-key contract with an arbitrary third-party
    // endpoint, so we cannot assume it was never processed.
    throw new AmbiguousOutcomeError(err instanceof Error ? err.message : "http request failed");
  }
  const responseBody = await res.json().catch(() => null);
  if (res.status >= 500) {
    return { output: { status: res.status, body: responseBody }, outcome: "ambiguous" };
  }
  return { output: { status: res.status, body: responseBody } };
};
