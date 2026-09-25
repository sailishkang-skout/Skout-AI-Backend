import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as authService from "../services/auth.service.js";
import { buildAuthProbeApp } from "../test/auth-probe-app.js";
import {
  AuthErrorCode,
  buildTestAuth,
  buildTestAuthEnv,
  ensureTestAuthHarness,
  HttpError,
  resetTestAuthHarness,
  TEST_CLERK_ISSUER,
  TEST_SKOUT_AUTH_ISSUER,
} from "@skout/auth";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const USER_EMAIL = "shared-contract@example.com";

const dualOverrides = buildTestAuthEnv(TEST_CLERK_ISSUER, {
  AUTH_ACCEPTED_ISSUERS: "clerk,skout",
  AUTH_MODE: "dual",
  CLERK_JWT_ISSUER: TEST_CLERK_ISSUER,
  AUTH_JWT_ISSUER: TEST_SKOUT_AUTH_ISSUER,
  AUTH_JWT_AUDIENCE: "skout-api",
});

beforeEach(() => {
  ensureTestAuthHarness();
});

afterEach(() => {
  resetTestAuthHarness();
  vi.restoreAllMocks();
});

describe("AUTH-BE-19 — Dual-verify mode (apps/api)", () => {
  it("Contract test: produces identical downstream request.* shape for Clerk vs Skout tokens", async () => {
    vi.spyOn(authService, "resolveOrProvisionUser").mockResolvedValue({
      userId: USER_ID,
      userEmail: USER_EMAIL,
      workspaceId: WORKSPACE_ID,
      role: "owner",
    });

    const app = await buildAuthProbeApp(dualOverrides);

    const clerkAuth = buildTestAuth({
      provider: "clerk",
      userId: USER_ID,
      email: USER_EMAIL,
      workspaceId: WORKSPACE_ID,
      role: "owner",
    });

    const skoutAuth = buildTestAuth({
      provider: "skout",
      userId: USER_ID,
      email: USER_EMAIL,
      workspaceId: WORKSPACE_ID,
      role: "owner",
    });

    const clerkRes = await app.inject({
      method: "GET",
      url: "/api/v1/__auth_probe",
      headers: { authorization: clerkAuth.bearer },
    });

    const skoutRes = await app.inject({
      method: "GET",
      url: "/api/v1/__auth_probe",
      headers: { authorization: skoutAuth.bearer },
    });

    expect(clerkRes.statusCode).toBe(200);
    expect(skoutRes.statusCode).toBe(200);

    const clerkBody = clerkRes.json();
    const skoutBody = skoutRes.json();

    expect(clerkBody).toEqual({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      role: "owner",
    });

    // Exact contract parity
    expect(skoutBody).toEqual(clerkBody);

    await app.close();
  });

  it("Config-only switching via AUTH_ACCEPTED_ISSUERS: clerk-only rejects Skout tokens", async () => {
    vi.spyOn(authService, "resolveOrProvisionUser").mockResolvedValue({
      userId: USER_ID,
      userEmail: USER_EMAIL,
      workspaceId: WORKSPACE_ID,
      role: "owner",
    });

    const app = await buildAuthProbeApp({
      ...dualOverrides,
      AUTH_ACCEPTED_ISSUERS: "clerk",
    });

    const clerkAuth = buildTestAuth({ provider: "clerk", userId: USER_ID });
    const skoutAuth = buildTestAuth({ provider: "skout", userId: USER_ID });

    const clerkRes = await app.inject({
      method: "GET",
      url: "/api/v1/__auth_probe",
      headers: { authorization: clerkAuth.bearer },
    });
    expect(clerkRes.statusCode).toBe(200);

    const skoutRes = await app.inject({
      method: "GET",
      url: "/api/v1/__auth_probe",
      headers: { authorization: skoutAuth.bearer },
    });
    expect(skoutRes.statusCode).toBe(401);

    await app.close();
  });

  it("Config-only switching via AUTH_ACCEPTED_ISSUERS: skout-only rejects Clerk tokens", async () => {
    vi.spyOn(authService, "resolveOrProvisionUser").mockResolvedValue({
      userId: USER_ID,
      userEmail: USER_EMAIL,
      workspaceId: WORKSPACE_ID,
      role: "owner",
    });

    const app = await buildAuthProbeApp({
      ...dualOverrides,
      AUTH_ACCEPTED_ISSUERS: "skout",
    });

    const clerkAuth = buildTestAuth({ provider: "clerk", userId: USER_ID });
    const skoutAuth = buildTestAuth({ provider: "skout", userId: USER_ID });

    const skoutRes = await app.inject({
      method: "GET",
      url: "/api/v1/__auth_probe",
      headers: { authorization: skoutAuth.bearer },
    });
    expect(skoutRes.statusCode).toBe(200);

    const clerkRes = await app.inject({
      method: "GET",
      url: "/api/v1/__auth_probe",
      headers: { authorization: clerkAuth.bearer },
    });
    expect(clerkRes.statusCode).toBe(401);

    await app.close();
  });

  it("returns 403 AUTH_ACCOUNT_BLOCKED when user is inactive or blocked", async () => {
    vi.spyOn(authService, "resolveOrProvisionUser").mockRejectedValue(
      new HttpError("Account is inactive or blocked", 403)
    );

    const app = await buildAuthProbeApp(dualOverrides);
    const skoutAuth = buildTestAuth({ provider: "skout", userId: USER_ID });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/__auth_probe",
      headers: { authorization: skoutAuth.bearer },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe(AuthErrorCode.AUTH_ACCOUNT_BLOCKED);

    await app.close();
  });

  it("returns 401 AUTH_SESSION_REVOKED when session is revoked", async () => {
    vi.spyOn(authService, "resolveOrProvisionUser").mockRejectedValue(
      new HttpError(AuthErrorCode.AUTH_SESSION_REVOKED, 401)
    );

    const app = await buildAuthProbeApp(dualOverrides);
    const skoutAuth = buildTestAuth({ provider: "skout", userId: USER_ID });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/__auth_probe",
      headers: { authorization: skoutAuth.bearer },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe(AuthErrorCode.AUTH_SESSION_REVOKED);

    await app.close();
  });
});

