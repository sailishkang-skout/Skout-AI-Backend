import { afterEach, describe, expect, it, vi } from "vitest";
import * as skoutAuth from "@skout/auth";
import { AuthErrorCode, AuthErrorMessage, AuthTokenExpiredError } from "@skout/auth";
import Fastify from "fastify";
import { loadEnv } from "../config/env.js";
import { authPlugin } from "../plugins/auth.js";
import { stepUpRoutes } from "./step-up.routes.js";
import { buildFakeClerkJwt, TEST_CLERK_ISSUER } from "../test/clerk-test-jwt.js";

const clerkOverrides = {
  CLERK_SECRET_KEY: "sk_test_clerk",
  CLERK_JWT_ISSUER: TEST_CLERK_ISSUER,
  AUTH_STUB: false,
  STEP_UP_SIGNING_SECRET: "step-up-test-signing-secret",
} as const;

async function buildStepUpProbeApp() {
  const config = { ...loadEnv(), ...clerkOverrides };
  const app = Fastify({ logger: { level: "fatal" } });
  app.decorate("config", config);
  app.decorate("db", {} as never);
  await app.register(authPlugin);
  await app.register(async (s) => s.register(stepUpRoutes), { prefix: "/api/v1" });
  await app.ready();
  return app;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/v1/auth/step-up — error codes", () => {
  it("returns AUTH_UNAUTHORIZED when request has no userId (handler guard)", async () => {
    const config = { ...loadEnv(), ...clerkOverrides };
    const app = Fastify({ logger: { level: "fatal" } });
    app.decorate("config", config);
    app.decorate("db", {} as never);
    await app.register(async (s) => s.register(stepUpRoutes), { prefix: "/api/v1" });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/step-up",
      payload: { clerkToken: buildFakeClerkJwt() },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({
      error: AuthErrorMessage.UNAUTHORIZED,
      code: AuthErrorCode.AUTH_UNAUTHORIZED,
    });
    await app.close();
  });

  it("returns AUTH_TOKEN_EXPIRED for expired step-up Clerk token", async () => {
    const sessionJwt = buildFakeClerkJwt();
    vi.spyOn(skoutAuth, "resolveAuth").mockImplementation(async (token) => {
      if (token === sessionJwt) {
        return { provider: "clerk", subject: "u1", emailVerified: true };
      }
      throw new AuthTokenExpiredError("jwt is expired");
    });
    vi.spyOn(skoutAuth, "resolveOrProvisionUser").mockResolvedValue({
      userId: "user-1",
      userEmail: "a@b.com",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      role: "member",
    });

    const app = await buildStepUpProbeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/step-up",
      headers: { authorization: `Bearer ${sessionJwt}` },
      payload: { clerkToken: buildFakeClerkJwt(TEST_CLERK_ISSUER, "step-up") },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({
      error: "jwt is expired",
      code: AuthErrorCode.AUTH_TOKEN_EXPIRED,
    });
    await app.close();
  });

  it("returns AUTH_REAUTH_USER_MISMATCH on user mismatch", async () => {
    const sessionJwt = buildFakeClerkJwt();
    const stepUpJwt = buildFakeClerkJwt(TEST_CLERK_ISSUER, "step-up-subject");
    vi.spyOn(skoutAuth, "resolveAuth").mockResolvedValue({
      provider: "clerk",
      subject: "same",
      emailVerified: true,
    });
    let provisionCalls = 0;
    vi.spyOn(skoutAuth, "resolveOrProvisionUser").mockImplementation(async () => {
      provisionCalls += 1;
      if (provisionCalls === 1) {
        return {
          userId: "session-user",
          userEmail: "a@b.com",
          workspaceId: "11111111-1111-4111-8111-111111111111",
          role: "member",
        };
      }
      return {
        userId: "other-user",
        userEmail: "a@b.com",
        workspaceId: "11111111-1111-4111-8111-111111111111",
        role: "member",
      };
    });

    const app = await buildStepUpProbeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/step-up",
      headers: { authorization: `Bearer ${sessionJwt}` },
      payload: { clerkToken: stepUpJwt },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      error: AuthErrorMessage.REAUTH_USER_MISMATCH,
      code: AuthErrorCode.AUTH_REAUTH_USER_MISMATCH,
    });
    await app.close();
  });
});
