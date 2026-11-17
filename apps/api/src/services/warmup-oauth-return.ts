import type { Env } from "../config/env.js";
import { productAppUrl } from "./cops-onboarding.service.js";

/** What happened on the Warm-Up Tool's OAuth callback, from the proxy's point of view. */
export type WarmupOAuthOutcome =
  | { status: number; body?: string }
  | { reason: string };

const SAFE_REASON = /^[A-Za-z0-9_.-]{1,64}$/;

function upstreamErrorCode(body: string | undefined): string | null {
  if (!body) return null;
  try {
    const code = (JSON.parse(body) as { error?: { code?: unknown } })?.error?.code;
    return typeof code === "string" && SAFE_REASON.test(code) ? code : null;
  } catch {
    return null;
  }
}

/**
 * Where to send the browser after Google/Microsoft redirect back through the
 * Warm-Up OAuth callback: the Mailboxes page, with `oauth=connected|error`,
 * the provider, and (on failure) a short machine-readable reason. Only a
 * whitelisted error code is ever reflected into the URL.
 */
export function warmupOAuthReturnUrl(
  config: Pick<Env, "FRONTEND_URL" | "CORS_ORIGIN">,
  provider: "google" | "microsoft",
  outcome: WarmupOAuthOutcome,
): string {
  const base = productAppUrl(config.FRONTEND_URL ?? config.CORS_ORIGIN[0] ?? "http://localhost:3000");
  const params = new URLSearchParams();

  const ok = "status" in outcome && outcome.status >= 200 && outcome.status < 300;
  params.set("oauth", ok ? "connected" : "error");
  params.set("provider", provider);
  if (!ok) {
    const reason = "reason" in outcome ? outcome.reason : upstreamErrorCode(outcome.body);
    params.set("reason", reason && SAFE_REASON.test(reason) ? reason : "connect_failed");
  }

  return `${base}/warmup/mailboxes?${params.toString()}`;
}
