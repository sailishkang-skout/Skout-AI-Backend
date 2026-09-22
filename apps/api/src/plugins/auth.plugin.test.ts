import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@skout/db";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { buildAuthProbeApp } from "../test/auth-probe-app.js";
import { buildFakeClerkJwt, TEST_CLERK_ISSUER } from "../test/clerk-test-jwt.js";

const ADMIN_WS = "11111111-1111-4111-8111-111111111111";
const ADMIN_SECRET = "test-admin-import-secret";

const clerkOverrides = {
  CLERK_SECRET_KEY: "sk_test_clerk",
  CLERK_JWT_ISSUER: TEST_CLERK_ISSUER,
  AUTH_STUB: false,
  ADMIN_IMPORT_SECRET: ADMIN_SECRET,
  ADMIN_IMPORT_WORKSPACE_ID: ADMIN_WS,
  EMAIL_INTEL_EXTERNAL_API_KEY: "email-intel-test-key",
} as const;

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
    const token = buildFakeClerkJwt("https://unknown-issuer.example");
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/__auth_probe",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it.skipIf(!process.env.DATABASE_URL)(
    "accepts a Clerk JWT on a protected route when Postgres is available",
    async () => {
      const config = loadEnv();
      const app = await buildApp({
        ...config,
        ...clerkOverrides,
        LOG_LEVEL: "fatal",
        OPENSEARCH_URL: undefined,
      });
      const token = buildFakeClerkJwt();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/team/members",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).not.toBe(401);
      await app.close();
    }
  );
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
  it.skipIf(!process.env.DATABASE_URL)("accepts a valid isk_ session token", async () => {
    const config = loadEnv();
    const app = await buildApp({
      ...config,
      ...clerkOverrides,
      LOG_LEVEL: "fatal",
      OPENSEARCH_URL: undefined,
    });
    const db = app.db;
    if (!db) throw new Error("expected db");

    const [user] = await db.select({ id: schema.users.id }).from(schema.users).limit(1);
    if (!user) throw new Error("need at least one user in test database");

    const [membership] = await db
      .select({ workspaceId: schema.workspaceMembers.workspaceId })
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.userId, user.id))
      .limit(1);
    if (!membership) throw new Error("need workspace membership for test user");

    const sessionToken = `isk_test_${Date.now()}`;
    await db.insert(schema.inviteSessions).values({
      userId: user.id,
      token: sessionToken,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/import/admin/ping",
      headers: { authorization: `Bearer ${sessionToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.workspaceId).toBe(membership.workspaceId);

    await db.delete(schema.inviteSessions).where(eq(schema.inviteSessions.token, sessionToken));
    await app.close();
  });

  it.skipIf(!process.env.DATABASE_URL)("rejects expired or unknown isk_ tokens", async () => {
    const config = loadEnv();
    const app = await buildApp({
      ...config,
      ...clerkOverrides,
      LOG_LEVEL: "fatal",
      OPENSEARCH_URL: undefined,
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/team/members",
      headers: { authorization: "Bearer isk_unknown_session" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
