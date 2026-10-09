import { randomUUID } from "node:crypto";
import { HttpError } from "@skout/auth";
import type { FastifyRequest } from "fastify";

/**
 * Global error envelope (Bible p.81, COPS-01 decision: Option A). Every API error uses
 * { code, message, details, request_id, retryable }. `code` is a stable machine code; `message`
 * is human-readable. `statusCode` is not in the body; the HTTP status carries it.
 */
export function errorResponse(message: string, statusCode = 400, details?: unknown) {
  return apiError(
    defaultCodeForStatus(statusCode),
    message,
    statusCode,
    details === undefined || details === null ? undefined : { details }
  );
}

export function defaultCodeForStatus(statusCode: number): string {
  if (statusCode === 400) return "BAD_REQUEST";
  if (statusCode === 401) return "UNAUTHORIZED";
  if (statusCode === 403) return "FORBIDDEN";
  if (statusCode === 404) return "NOT_FOUND";
  if (statusCode === 409) return "BUSINESS_STATE_CONFLICT";
  if (statusCode === 415) return "UNSUPPORTED_MEDIA_TYPE";
  if (statusCode === 422) return "VALIDATION_FAILED";
  if (statusCode === 429) return "RATE_LIMITED";
  return statusCode >= 500 ? "INTERNAL_ERROR" : "REQUEST_FAILED";
}

/** Only transient throttling and gateway failures are marked retryable by default. */
function isRetryableStatus(statusCode: number): boolean {
  return statusCode === 429 || statusCode === 503 || statusCode === 504;
}

/** §3 auth failures — stable `code` plus legacy `error` message text (AUTH-BE-08). */
export { authErrorResponse } from "@skout/auth";

export function successResponse(data: unknown) {
  return {
    ok: true,
    data,
  };
}

export { HttpError };

/**
 * `authPlugin`'s preHandler hook always sets `request.workspaceId` from server-verified
 * identity before any route handler runs (Clerk JWT / stub auth / invite session / admin
 * import token) — a missing value here means that guarantee was somehow violated, not a
 * normal "no tenant" case. Fail closed (401) instead of silently proceeding with a
 * placeholder tenant id, which is what `request.workspaceId ?? "unknown"` used to do.
 */
export function requireWorkspaceId(request: FastifyRequest): string {
  if (!request.workspaceId) {
    throw new HttpError("Missing workspace context", 401);
  }
  return request.workspaceId;
}

/**
 * True when an error originates from the database layer (Drizzle/postgres).
 * These must never be returned verbatim to clients — they leak SQL and schema.
 */
export function isDatabaseError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { code?: unknown; query?: unknown; message?: unknown };
  if ("query" in e) return true;
  // postgres error codes are 5-char SQLSTATE strings (e.g. 23505, 42P01).
  if (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) return true;
  if (e.code === "ECONNREFUSED") return true;
  if (typeof e.message === "string" && /failed query:|drizzle|relation .* does not exist/i.test(e.message)) {
    return true;
  }
  return false;
}

/**
 * Standard error envelope used by the global handler, not-found, and method
 * handlers so every API error has the same shape: { error, message, statusCode }.
 * `error` is a stable machine code; `message` is human-readable.
 */
export function apiError(
  code: string,
  message: string,
  statusCode: number,
  extra?: Record<string, unknown>
) {
  const { requestId, details, retryable, ...rest } = (extra ?? {}) as Record<string, unknown>;
  return {
    ok: false,
    error: code,
    code,
    message,
    statusCode,
    details: (details as unknown) ?? (Object.keys(rest).length ? rest : null),
    request_id: typeof requestId === "string" ? requestId : randomUUID(),
    retryable: typeof retryable === "boolean" ? retryable : isRetryableStatus(statusCode),
  };
}
