/**
 * AUTH-BE-20 — per-issuer auth metrics and audit logging (emit only).
 *
 * Structured log lines with a stable `metric` name + tag fields, keyed exactly on the names
 * this ticket specifies: auth.verify{issuer, result}, auth.login{result}, auth.refresh{result},
 * auth.refresh_reuse. No dedicated counter/metrics-emission library exists yet in
 * @skout/observability (only logging/tracing/Sentry/Datadog-tracer init) — Datadog's log
 * pipeline derives log-based metrics from structured JSON fields, which is the existing
 * convention this codebase already relies on (see @skout/observability's redact/logger setup),
 * so that's what these functions emit into. AUTH-ADI-12 builds the actual dashboards/alarms
 * from these; this module only emits.
 *
 * Ground Rule 3 / this ticket's own requirement: no tokens, no emails — only user id (when
 * known) and issuer/result tags ever go into these fields.
 *
 * Wiring status: auth.verify is wired into resolve-auth.ts (the shared verifier, merged);
 * auth.refresh / auth.refresh_reuse are wired into session.service.ts's rotateRefreshToken
 * (BE-13, merged); auth.login is wired into apps/api/src/routes/auth-core.routes.ts's
 * POST /auth/login handler (BE-20).
 */
import { createLogger } from "@skout/observability";

const log = createLogger("auth.metrics");

export type AuthMetricResult = "success" | "failure";

export function emitAuthVerifyMetric(params: {
  issuer: string;
  result: AuthMetricResult;
  userId?: string;
}): void {
  log.info("auth.verify", {
    metric: "auth.verify",
    issuer: params.issuer,
    result: params.result,
    ...(params.userId ? { userId: params.userId } : {}),
  });
}

export function emitAuthLoginMetric(params: { result: AuthMetricResult; userId?: string }): void {
  log.info("auth.login", {
    metric: "auth.login",
    result: params.result,
    ...(params.userId ? { userId: params.userId } : {}),
  });
}

export function emitAuthRefreshMetric(params: { result: AuthMetricResult; userId?: string }): void {
  log.info("auth.refresh", {
    metric: "auth.refresh",
    result: params.result,
    ...(params.userId ? { userId: params.userId } : {}),
  });
}

/** Refresh-token reuse (theft signal) — a possible-attack event, so this is a warn, not info. */
export function emitAuthRefreshReuseMetric(params: { userId?: string; sessionId?: string }): void {
  log.warn("auth.refresh_reuse", {
    metric: "auth.refresh_reuse",
    ...(params.userId ? { userId: params.userId } : {}),
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
  });
}
