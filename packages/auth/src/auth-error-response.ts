import type { AuthErrorCode } from "./auth-error-codes.js";

/** Auth failure envelope: `error` stays human-readable; `code` is the stable §3 contract. */
export function authErrorResponse(
  code: AuthErrorCode,
  message: string,
  statusCode: number,
  details?: unknown
) {
  return {
    ok: false,
    error: message,
    code,
    statusCode,
    details: details ?? null,
  };
}
