import { z } from "zod";

const idParamSchema = z.object({ id: z.string().uuid() });

/**
 * Parses `:id` route params as a UUID, throwing the same ZodError → 400
 * `validation_error` that body/query validation produces. Without this, a
 * malformed id reaches the DB as a raw string and Postgres's "invalid input
 * syntax for type uuid" error bubbles up as an unhandled 500 instead of a
 * clean 4xx.
 */
export function parseIdParam(request: { params: unknown }): string {
  return idParamSchema.parse(request.params).id;
}

export function errorResponse(message: string, statusCode = 400, details?: unknown) {
  return {
    ok: false,
    error: message,
    statusCode,
    details: details ?? null,
  };
}

export { HttpError } from "@skout/auth";

/**
 * Postgres error code (e.g. "23505" unique_violation) if `error` is — or wraps — one.
 * drizzle-orm wraps the raw `postgres` driver error in a DrizzleQueryError and puts the
 * original on `.cause`, so the code isn't on the top-level error object.
 */
export function pgErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === "string") return direct;
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause === "object" && cause !== null) {
    const causeCode = (cause as { code?: unknown }).code;
    if (typeof causeCode === "string") return causeCode;
  }
  return undefined;
}

export function isDatabaseError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { code?: unknown; query?: unknown; message?: unknown };
  if ("query" in e) return true;
  if (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) return true;
  if (e.code === "ECONNREFUSED") return true;
  if (typeof e.message === "string" && /failed query:|drizzle|relation .* does not exist/i.test(e.message)) {
    return true;
  }
  return false;
}

export function apiError(code: string, message: string, statusCode: number, extra?: Record<string, unknown>) {
  return { error: code, message, statusCode, ...(extra ?? {}) };
}
