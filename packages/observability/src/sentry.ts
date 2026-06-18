import * as Sentry from "@sentry/node";
import { isConfiguredSecret } from "./keys.js";

export interface SentryInitOptions {
  dsn?: string;
  service: string;
  environment: string;
  release?: string;
  tracesSampleRate?: number;
}

export function isSentryEnabled(dsn?: string): boolean {
  return isConfiguredSecret(dsn);
}

/** Initialize Sentry when DSN is configured. Never throws — app runs without Sentry. */
export function initSentry(options: SentryInitOptions): void {
  if (!isSentryEnabled(options.dsn)) return;

  try {
    Sentry.init({
      dsn: options.dsn,
      environment: options.environment,
      release: options.release,
      tracesSampleRate: options.tracesSampleRate ?? 0.1,
      serverName: options.service,
      beforeSend(event) {
        if (event.request?.headers) {
          delete event.request.headers.authorization;
          delete event.request.headers.Authorization;
        }
        return event;
      },
    });
  } catch {
    // Invalid/expired DSN or network issue at startup — observability is optional.
  }
}

export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!Sentry.getClient()) return;
  try {
    Sentry.withScope((scope) => {
      if (context) scope.setContext("skout", context);
      Sentry.captureException(error);
    });
  } catch {
    // Sentry unreachable or misconfigured — ignore.
  }
}

export function setSentryUser(user: { id?: string; email?: string; workspaceId?: string }): void {
  if (!Sentry.getClient()) return;
  try {
    Sentry.setUser({
      id: user.id,
      email: user.email,
      ...(user.workspaceId ? { workspaceId: user.workspaceId } : {}),
    });
  } catch {
    // ignore
  }
}

export { Sentry };
