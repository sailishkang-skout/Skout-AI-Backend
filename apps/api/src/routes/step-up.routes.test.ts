import { afterEach, describe, expect, it, vi } from "vitest";
import * as skoutAuth from "@skout/auth";
import { buildStepUpProbeApp } from "../test/step-up-probe-app.js";
import { buildFakeClerkJwt, TEST_CLERK_ISSUER } from "../test/clerk-test-jwt.js";

const SESSION_USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const clerkOverrides = {
  CLERK_SECRET_KEY: "sk_test_clerk",
  CLERK_JWT_ISSUER: TEST_CLERK_ISSUER,
  AUTH_STUB: false,
  STEP_UP_SIGNING_SECRET: "step-up-test-signing-secret",
} as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/v1/auth/step-up", () => {
  it("returns 401 when the request is not authenticated", async () => {
    const app = await buildStepUpProbeApp(clerkOverrides);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/step-up",
      payload: { clerkToken: buildFakeClerkJwt() },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns 403 when re-auth resolves to a different internal user", async () => {
    const app = await buildStepUpProbeApp(clerkOverrides);
    const sessionJwt = buildFakeClerkJwt(TEST_CLERK_ISSUER, "session-subject");
    const stepUpJwt = buildFakeClerkJwt(TEST_CLERK_ISSUER, "step-up-subject");

    vi.spyOn(skoutAuth, "resolveAuth").mockImplementation(async (token) => {
      if (token === sessionJwt) {
        return { provider: "clerk", subject: "clerk_session", emailVerified: true };
      }
      if (token === stepUpJwt) {
        return { provider: "clerk", subject: "clerk_other", emailVerified: true };
      }
      throw new skoutAuth.AuthTokenInvalidError();
    });

    vi.spyOn(skoutAuth, "resolveOrProvisionUser").mockImplementation(async (_db, identity) => {
      const subject = typeof identity === "string" ? identity : identity.subject;
      return {
      userId: subject === "clerk_session" ? SESSION_USER_ID : OTHER_USER_ID,
      userEmail: "user@example.com",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      role: "member",
    };
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/step-up",
      headers: { authorization: `Bearer ${sessionJwt}` },
      payload: { clerkToken: stepUpJwt },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/does not match/i);
    await app.close();
  });

  it("issues a reauth token when the step-up Clerk token matches the session user", async () => {
    const app = await buildStepUpProbeApp(clerkOverrides);
    const sessionJwt = buildFakeClerkJwt(TEST_CLERK_ISSUER, "session-subject");
    const stepUpJwt = buildFakeClerkJwt(TEST_CLERK_ISSUER, "step-up-subject");

    vi.spyOn(skoutAuth, "resolveAuth").mockResolvedValue({
      provider: "clerk",
      subject: "clerk_same",
      emailVerified: true,
    });

    vi.spyOn(skoutAuth, "resolveOrProvisionUser").mockResolvedValue({
      userId: SESSION_USER_ID,
      userEmail: "user@example.com",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      role: "member",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/step-up",
      headers: { authorization: `Bearer ${sessionJwt}` },
      payload: { clerkToken: stepUpJwt },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.reauthToken).toBeTypeOf("string");
    expect(res.json().data.expiresInMinutes).toBe(15);
    await app.close();
  });
});
