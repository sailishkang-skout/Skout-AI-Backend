import { describe, expect, it } from "vitest";
import { HttpError } from "./http.js";
import {
  AuthErrorCode,
  AuthErrorMessage,
  isJwtExpiredMessage,
  resolveAuthErrorCode,
} from "./auth-error-codes.js";
import { AuthTokenExpiredError, AuthTokenInvalidError } from "./auth-token.js";

describe("resolveAuthErrorCode", () => {
  it("maps AuthTokenExpiredError to AUTH_TOKEN_EXPIRED", () => {
    expect(resolveAuthErrorCode(new AuthTokenExpiredError("jwt is expired"))).toBe(
      AuthErrorCode.AUTH_TOKEN_EXPIRED
    );
  });

  it("maps generic AuthTokenInvalidError to AUTH_TOKEN_INVALID", () => {
    expect(resolveAuthErrorCode(new AuthTokenInvalidError())).toBe(AuthErrorCode.AUTH_TOKEN_INVALID);
  });

  it("maps blocked account HttpError to AUTH_ACCOUNT_BLOCKED", () => {
    expect(
      resolveAuthErrorCode(new HttpError(AuthErrorMessage.ACCOUNT_INACTIVE_OR_BLOCKED, 403))
    ).toBe(AuthErrorCode.AUTH_ACCOUNT_BLOCKED);
  });

  it("detects expired wording in fallback messages", () => {
    expect(resolveAuthErrorCode(null, "Token jwt is expired")).toBe(AuthErrorCode.AUTH_TOKEN_EXPIRED);
  });
});

describe("isJwtExpiredMessage", () => {
  it("matches Clerk-style expired JWT text", () => {
    expect(isJwtExpiredMessage("jwt is expired")).toBe(true);
    expect(isJwtExpiredMessage("Invalid authorization token")).toBe(false);
  });
});
