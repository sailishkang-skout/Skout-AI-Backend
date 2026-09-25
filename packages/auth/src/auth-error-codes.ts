import { HttpError } from "./http.js";
import { AuthTokenExpiredError, AuthTokenInvalidError } from "./auth-token.js";

/**
 * §3 stable auth failure codes (AUTH-BE-08). Keep in sync with AUTH-BE-14 / AUTH-FE-02.
 */
export const AuthErrorCode = {
  AUTH_MISSING_TOKEN: "AUTH_MISSING_TOKEN",
  AUTH_TOKEN_EXPIRED: "AUTH_TOKEN_EXPIRED",
  AUTH_TOKEN_INVALID: "AUTH_TOKEN_INVALID",
  AUTH_ACCOUNT_BLOCKED: "AUTH_ACCOUNT_BLOCKED",
  AUTH_SESSION_INVALID: "AUTH_SESSION_INVALID",
  AUTH_UNAUTHORIZED: "AUTH_UNAUTHORIZED",
  AUTH_REAUTH_USER_MISMATCH: "AUTH_REAUTH_USER_MISMATCH",
  // --- AUTH-BE-14 (§3 core auth endpoints) ---
  AUTH_SESSION_REVOKED: "AUTH_SESSION_REVOKED",
  AUTH_INVALID_CREDENTIALS: "AUTH_INVALID_CREDENTIALS",
  AUTH_RATE_LIMITED: "AUTH_RATE_LIMITED",
  AUTH_EMAIL_NOT_VERIFIED: "AUTH_EMAIL_NOT_VERIFIED",
} as const;

export type AuthErrorCode = (typeof AuthErrorCode)[keyof typeof AuthErrorCode];

/** Human-readable messages preserved for backward compatibility (do not change wording). */
export const AuthErrorMessage = {
  MISSING_BEARER: "Missing bearer token",
  INVALID_AUTHORIZATION: "Invalid authorization token",
  SESSION_EXPIRED_OR_INVALID: "Session expired or invalid",
  ACCOUNT_INACTIVE_OR_BLOCKED: "Account is inactive or blocked",
  STEP_UP_CLERK_INVALID: "Invalid or expired Clerk token",
  UNAUTHORIZED: "Unauthorized",
  REAUTH_USER_MISMATCH: "Re-authentication does not match the current session",
} as const;

export function isJwtExpiredMessage(message: string): boolean {
  return /jwt is expired/i.test(message) || /\bexpired\b/i.test(message);
}

export function resolveAuthErrorCode(error: unknown, messageFallback = ""): AuthErrorCode {
  if (error instanceof AuthTokenExpiredError) {
    return AuthErrorCode.AUTH_TOKEN_EXPIRED;
  }
  if (error instanceof AuthTokenInvalidError) {
    if (isJwtExpiredMessage(error.message)) {
      return AuthErrorCode.AUTH_TOKEN_EXPIRED;
    }
    return AuthErrorCode.AUTH_TOKEN_INVALID;
  }
  if (error instanceof HttpError) {
    if (error.statusCode === 403 && (error.message === AuthErrorMessage.ACCOUNT_INACTIVE_OR_BLOCKED || error.message === AuthErrorCode.AUTH_ACCOUNT_BLOCKED)) {
      return AuthErrorCode.AUTH_ACCOUNT_BLOCKED;
    }
    if ((Object.values(AuthErrorCode) as string[]).includes(error.message)) {
      return error.message as AuthErrorCode;
    }
  }
  const message = messageFallback || (error instanceof Error ? error.message : "");
  if (isJwtExpiredMessage(message)) {
    return AuthErrorCode.AUTH_TOKEN_EXPIRED;
  }
  if ((Object.values(AuthErrorCode) as string[]).includes(message)) {
    return message as AuthErrorCode;
  }
  return AuthErrorCode.AUTH_TOKEN_INVALID;
}

