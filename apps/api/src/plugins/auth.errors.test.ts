import { afterEach, describe, expect, it, vi } from "vitest";
import * as skoutAuth from "@skout/auth";
import {
  AuthErrorCode,
  AuthErrorMessage,
  AuthTokenExpiredError,
  HttpError,
} from "@skout/auth";
import * as authService from "../services/auth.service.js";
import { buildAuthProbeApp } from "../test/auth-probe-app.js";
import { buildFakeClerkJwt, TEST_CLERK_ISSUER } from "../test/clerk-test-jwt.js";

const clerkOverrides = {
  CLERK_SECRET_KEY: "sk_test_clerk",
  CLERK_JWT_ISSUER: TEST_CLERK_ISSUER,
  AUTH_STUB: false,
  AUTH_MODE: "clerk" as const,
  AUTH_MODE_LEGACY_DERIVED: false,
  AUTH_USE_STUB: false,
  AUTH_USE_CLERK_JWT: true,
} as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("API auth plugin — structured error codes (AUTH-BE-08)", () => {
  it("returns AUTH_MISSING_TOKEN for missing bearer", async () => {
    const app = await buildAuthProbeApp(clerkOverrides);
    const res = await app.inject({ method: "GET", url: "/api/v1/__auth_probe" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({
      error: AuthErrorMessage.MISSING_BEARER,
      code: AuthErrorCode.AUTH_MISSING_TOKEN,
    });
    await app.close();
  });

  it("returns AUTH_TOKEN_INVALID for unknown issuer JWT", async () => {
    const app = await buildAuthProbeApp(clerkOverrides);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/__auth_probe",
      headers: { authorization: `Bearer ${buildFakeClerkJwt("https://evil.example")}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe(AuthErrorCode.AUTH_TOKEN_INVALID);
    await app.close();
  });

  it("returns AUTH_TOKEN_EXPIRED when resolveAuth throws expired", async () => {
    vi.spyOn(skoutAuth, "resolveAuth").mockRejectedValue(new AuthTokenExpiredError("jwt is expired"));

    const app = await buildAuthProbeApp(clerkOverrides);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/__auth_probe",
      headers: { authorization: `Bearer ${buildFakeClerkJwt()}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({
      error: "jwt is expired",
      code: AuthErrorCode.AUTH_TOKEN_EXPIRED,
    });
    await app.close();
  });

  it("returns AUTH_ACCOUNT_BLOCKED when provisioning rejects blocked user", async () => {
    vi.spyOn(skoutAuth, "resolveAuth").mockResolvedValue({
      provider: "clerk",
      subject: "user-1",
      emailVerified: true,
    });
    vi.spyOn(authService, "resolveOrProvisionUser").mockRejectedValue(
      new HttpError(AuthErrorMessage.ACCOUNT_INACTIVE_OR_BLOCKED, 403)
    );

    const app = await buildAuthProbeApp(clerkOverrides);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/__auth_probe",
      headers: { authorization: `Bearer ${buildFakeClerkJwt()}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      error: AuthErrorMessage.ACCOUNT_INACTIVE_OR_BLOCKED,
      code: AuthErrorCode.AUTH_ACCOUNT_BLOCKED,
    });
    await app.close();
  });
});
