import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as skoutAuth from "@skout/auth";
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
const USER_EMAIL = "shared-crm-contract@example.com";

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

describe("AUTH-BE-19 — Dual-verify mode (apps/crm)", () => {
  it("Contract test: produces identical downstream request.* shape for Clerk vs Skout tokens in CRM", async () => {
    vi.spyOn(skoutAuth, "resolveOrProvisionUser").mockResolvedValue({
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

    const skoutAuthToken = buildTestAuth({
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
      headers: { authorization: skoutAuthToken.bearer },
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

    expect(skoutBody).toEqual(clerkBody);

    await app.close();
  });

  it("Config-only switching via AUTH_ACCEPTED_ISSUERS: clerk-only rejects Skout tokens in CRM", async () => {
    vi.spyOn(skoutAuth, "resolveOrProvisionUser").mockResolvedValue({
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
    const skoutAuthToken = buildTestAuth({ provider: "skout", userId: USER_ID });

    const clerkRes = await app.inject({
      method: "GET",
      url: "/api/v1/__auth_probe",
      headers: { authorization: clerkAuth.bearer },
    });
    expect(clerkRes.statusCode).toBe(200);

    const skoutRes = await app.inject({
      method: "GET",
      url: "/api/v1/__auth_probe",
      headers: { authorization: skoutAuthToken.bearer },
    });
    expect(skoutRes.statusCode).toBe(401);

    await app.close();
  });

  it("Config-only switching via AUTH_ACCEPTED_ISSUERS: skout-only rejects Clerk tokens in CRM", async () => {
    vi.spyOn(skoutAuth, "resolveOrProvisionUser").mockResolvedValue({
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
    const skoutAuthToken = buildTestAuth({ provider: "skout", userId: USER_ID });

    const skoutRes = await app.inject({
      method: "GET",
      url: "/api/v1/__auth_probe",
      headers: { authorization: skoutAuthToken.bearer },
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
});

