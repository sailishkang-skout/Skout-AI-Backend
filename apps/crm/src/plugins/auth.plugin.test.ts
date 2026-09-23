import { afterEach, describe, expect, it, vi } from "vitest";
import * as skoutAuth from "@skout/auth";
import { buildAuthProbeApp } from "../test/auth-probe-app.js";
import { buildTestAuthEnv, buildTestAuthToken, TEST_CLERK_ISSUER } from "@skout/auth";

const clerkOverrides = buildTestAuthEnv(TEST_CLERK_ISSUER);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CRM auth plugin — public and internal allowlist", () => {
  it("does not require auth for GET /api/v1/crm/health", async () => {
    const app = await buildAuthProbeApp(clerkOverrides);
    const res = await app.inject({ method: "GET", url: "/api/v1/crm/health" });
    expect(res.statusCode).not.toBe(401);
    await app.close();
  });

  it("does not require Clerk auth for POST /api/v1/webhooks/meeting-rsvp", async () => {
    const app = await buildAuthProbeApp(clerkOverrides);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/meeting-rsvp",
      payload: {},
    });
    expect(res.statusCode).not.toBe(401);
    await app.close();
  });

  it("does not require Clerk auth for POST /api/v1/meetings/webhook", async () => {
    const app = await buildAuthProbeApp(clerkOverrides);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/meetings/webhook",
      payload: {},
    });
    expect(res.statusCode).not.toBe(401);
    await app.close();
  });

  it("does not require Clerk auth for /internal/v1/* (handler may still enforce service token)", async () => {
    const app = await buildAuthProbeApp(clerkOverrides);
    const res = await app.inject({ method: "GET", url: "/internal/v1/__probe" });
    expect(res.statusCode).not.toBe(401);
    await app.close();
  });
});

describe("CRM auth plugin — Clerk bearer (resolveAuth)", () => {
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

  it("accepts a Clerk JWT via resolveAuth and provisions the user", async () => {
    vi.spyOn(skoutAuth, "resolveOrProvisionUser").mockResolvedValue({
      userId: "crm-user-1",
      userEmail: "user@example.com",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      role: "member",
    });

    const app = await buildAuthProbeApp(clerkOverrides);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/__auth_probe",
      headers: { authorization: `Bearer ${buildTestAuthToken()}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      userId: "crm-user-1",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      role: "member",
    });
    await app.close();
  });

  it("does not treat isk_ tokens as invite sessions (no isk_ branch — product TBD)", async () => {
    const app = await buildAuthProbeApp(clerkOverrides);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/__auth_probe",
      headers: { authorization: "Bearer isk_some_session_token" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
