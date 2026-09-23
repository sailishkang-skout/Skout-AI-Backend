import { afterEach, describe, expect, it, vi } from "vitest";
import * as authService from "../services/auth.service.js";
import { buildAuthProbeApp } from "../test/auth-probe-app.js";
import { buildTestAuthEnv, buildTestAuthToken, TEST_CLERK_ISSUER } from "@skout/auth";
import { mockDbForIskSession } from "../test/mock-isk-db.js";

const ADMIN_WS = "11111111-1111-4111-8111-111111111111";
const ADMIN_SECRET = "test-admin-import-secret";
const ISK_USER_ID = "22222222-2222-4222-8222-222222222222";
const ISK_WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";

const clerkOverrides = buildTestAuthEnv(TEST_CLERK_ISSUER, {
  ADMIN_IMPORT_SECRET: ADMIN_SECRET,
  ADMIN_IMPORT_WORKSPACE_ID: ADMIN_WS,
  EMAIL_INTEL_EXTERNAL_API_KEY: "email-intel-test-key",
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("auth plugin — public routes", () => {
  it("does not require auth for GET /api/v1/health", async () => {
    const app = await buildAuthProbeApp(clerkOverrides);
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).not.toBe(401);
    await app.close();
  });
});

describe("auth plugin — Clerk bearer (resolveAuth)", () => {
  it("returns 401 when a protected route has no bearer token", async () => {
    const app = await buildAuthProbeApp(clerkOverrides);
    const res = await app.inject({ method: "GET", url: "/api/v1/__auth_probe" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns 401 for a JWT with an unknown issuer", async () => {
    const app = await buildAuthProbeApp(clerkOverrides);
    const token = buildTestAuthToken("https://unknown-issuer.example");
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/__auth_probe",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("accepts a Clerk JWT on a protected route via resolveAuth", async () => {
    vi.spyOn(authService, "resolveOrProvisionUser").mockResolvedValue({
      userId: "user-clerk-provisioned",
      userEmail: "clerk@example.com",
      workspaceId: ISK_WORKSPACE_ID,
      role: "member",
    });

    const app = await buildAuthProbeApp(clerkOverrides);
    const token = buildTestAuthToken();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/__auth_probe",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      userId: "user-clerk-provisioned",
      workspaceId: ISK_WORKSPACE_ID,
      role: "member",
    });
    await app.close();
  });
});

describe("auth plugin — admin_ import secret", () => {
  it("allows admin_ bearer only on /api/v1/import/* routes", async () => {
    const app = await buildAuthProbeApp(clerkOverrides);
    const bearer = `Bearer admin_${ADMIN_SECRET}`;

    const importRes = await app.inject({
      method: "GET",
      url: "/api/v1/import/admin/ping",
      headers: { authorization: bearer },
    });
    expect(importRes.statusCode).toBe(200);
    expect(importRes.json()).toEqual({ data: { ok: true, workspaceId: ADMIN_WS } });

    const otherRes = await app.inject({
      method: "GET",
      url: "/api/v1/__auth_probe",
      headers: { authorization: bearer },
    });
    expect(otherRes.statusCode).toBe(401);

    await app.close();
  });

  it("rejects admin_ bearer with the wrong secret", async () => {
    const app = await buildAuthProbeApp(clerkOverrides);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/import/admin/ping",
      headers: { authorization: "Bearer admin_wrong-secret" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("auth plugin — email-intel API key", () => {
  it("authenticates email-intel routes via x-api-key without a Clerk bearer", async () => {
    const app = await buildAuthProbeApp(clerkOverrides);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/email-intel/verify",
      headers: { "x-api-key": "email-intel-test-key" },
      payload: {},
    });
    expect(res.statusCode).not.toBe(401);
    await app.close();
  });

  it("returns 401 for email-intel routes without credentials", async () => {
    const app = await buildAuthProbeApp(clerkOverrides);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/email-intel/verify",
      payload: { email: "a@b.com" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("auth plugin — isk_ invite session", () => {
  it("accepts a valid isk_ session token", async () => {
    const sessionToken = "isk_test_valid_session";
    const app = await buildAuthProbeApp(
      clerkOverrides,
      mockDbForIskSession({
        sessionToken,
        userId: ISK_USER_ID,
        workspaceId: ISK_WORKSPACE_ID,
        role: "admin",
      })
    );

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/import/admin/ping",
      headers: { authorization: `Bearer ${sessionToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.workspaceId).toBe(ISK_WORKSPACE_ID);
    await app.close();
  });

  it("rejects expired or unknown isk_ tokens", async () => {
    const app = await buildAuthProbeApp(
      clerkOverrides,
      mockDbForIskSession({
        sessionToken: "isk_unknown_session",
        userId: ISK_USER_ID,
        workspaceId: ISK_WORKSPACE_ID,
        sessionValid: false,
      })
    );
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/__auth_probe",
      headers: { authorization: "Bearer isk_unknown_session" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
