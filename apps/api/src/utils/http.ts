import { HttpError } from "@skout/auth";
import type { FastifyRequest } from "fastify";

export function errorResponse(message: string, statusCode = 400, details?: unknown) {
  return {
    ok: false,
    error: message,
    statusCode,
    details: details ?? null,
  };
}

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
export function apiError(code: string, message: string, statusCode: number, extra?: Record<string, unknown>) {
  return { error: code, message, statusCode, ...(extra ?? {}) };
}
