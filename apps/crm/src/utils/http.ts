export function errorResponse(message: string, statusCode = 400, details?: unknown) {
  return {
    ok: false,
    error: message,
    statusCode,
    details: details ?? null,
  };
}

export { HttpError } from "@skout/auth";

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
