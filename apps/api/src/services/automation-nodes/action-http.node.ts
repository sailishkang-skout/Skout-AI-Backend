import { resolveAutomationSecret } from "../automation-secrets.service.js";
import { AmbiguousOutcomeError } from "./types.js";
import type { NodeHandler } from "./types.js";

/**
 * Config: { url: string; method?: string; headers?: Record<string,string>; body?: unknown;
 * credentialId?: string; credentialHeaderName?: string }. When credentialId is set, the resolved
 * secret is attached as a header (default "Authorization") — never logged or included in output.
 */
export const httpActionNodeHandler: NodeHandler = async (ctx) => {
  const { url, method = "GET", headers, body, credentialId, credentialHeaderName } = ctx.node.config as {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    credentialId?: string;
    credentialHeaderName?: string;
  };

  if (ctx.isSimulation) {
    return { output: { simulated: true, url, method } };
  }

  const resolvedHeaders: Record<string, string> = { ...headers };
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
