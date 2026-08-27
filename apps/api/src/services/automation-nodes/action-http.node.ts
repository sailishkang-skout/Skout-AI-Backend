import { resolveAutomationSecret } from "../automation-secrets.service.js";
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

  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...resolvedHeaders },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const responseBody = await res.json().catch(() => null);
  return { output: { status: res.status, body: responseBody } };
};
