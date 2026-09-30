/**
 * AUTH-BE-16-R1 — OAuth state replay checks must fail closed on a Redis error, not open.
 *
 * Environment-independent: mocks ../lib/redis.js directly rather than depending on a real Redis
 * (unlike microsoft-auth.service.test.ts's Redis describe block, which is
 * `describe.skipIf(!process.env.REDIS_URL)` and so never runs without one). This is what
 * actually proves the fix, since a skipped test proves nothing.
 */
import { describe, expect, it, vi } from "vitest";

const delMock = vi.fn(async () => {
  throw new Error("simulated Redis error (e.g. connection reset, timeout)");
});
const setMock = vi.fn(async () => "OK");

vi.mock("../lib/redis.js", () => ({
  getRedis: () => ({ del: delMock, set: setMock }),
}));

import { loadEnv, type Env } from "../config/env.js";
import {
  createGoogleOAuthState,
  verifyAndConsumeGoogleOAuthState,
} from "./google-auth.service.js";
import {
  createMicrosoftOAuthState,
  verifyAndConsumeMicrosoftOAuthState,
} from "./microsoft-auth.service.js";

function makeConfig(overrides: Partial<Env> = {}): Env {
  return {
    ...loadEnv(),
    REDIS_URL: "redis://fail-closed-test:6379",
    AUTH_REFRESH_TOKEN_PEPPER: "test-pepper-do-not-use-in-prod",
    GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
    MICROSOFT_OAUTH_CLIENT_ID: "11111111-aaaa-4bbb-8ccc-222222222222",
    MICROSOFT_OAUTH_CLIENT_SECRET: "test-ms-secret",
    MICROSOFT_OAUTH_TENANT: "common",
    FRONTEND_URL: "https://app.example.test",
    ...overrides,
  };
}

describe("verifyAndConsumeMicrosoftOAuthState — Redis error fails closed", () => {
  it("rejects the state (returns null) when redis.del throws, instead of accepting it", async () => {
    const config = makeConfig();
    const { stateId, signedState } = await createMicrosoftOAuthState(config, { verifier: "v", nonce: "n" });

    const result = await verifyAndConsumeMicrosoftOAuthState(config, signedState, stateId);

    expect(delMock).toHaveBeenCalled();
    expect(result).toBeNull();
  });
});

describe("verifyAndConsumeGoogleOAuthState — Redis error fails closed", () => {
  it("rejects the state (returns null) when redis.del throws, instead of accepting it", async () => {
    const config = makeConfig();
    const { stateId, signedState } = await createGoogleOAuthState(config, { verifier: "v", nonce: "n" });

    const result = await verifyAndConsumeGoogleOAuthState(config, signedState, stateId);

    expect(delMock).toHaveBeenCalled();
    expect(result).toBeNull();
  });
});
