import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from "jose";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const logCalls = vi.hoisted(() => [] as unknown[][]);
vi.mock("@skout/observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@skout/observability")>();
  const record = (...args: unknown[]) => void logCalls.push(args);
  return {
    ...actual,
    createLogger: () => ({ debug: record, info: record, warn: record, error: record }),
  };
});

import { loadEnv, type Env } from "../config/env.js";
import { signOAuthState } from "../utils/oauth-state.js";
import {
  clearConsumedStateIdsForTesting,
  createGoogleOAuthState,
  getGoogleOAuthCredentials,
  verifyAndConsumeGoogleOAuthState,
  verifyGoogleIdToken,
} from "./google-auth.service.js";

const CLIENT_ID = "login-client.apps.googleusercontent.com";
const PEPPER = "test-pepper-do-not-use-in-prod";

function makeConfig(overrides: Partial<Env> = {}): Env {
  return {
    ...loadEnv(),
    REDIS_URL: "",
    AUTH_REFRESH_TOKEN_PEPPER: PEPPER,
    GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: "login-secret",
    ...overrides,
  };
}

describe("google-auth.service (AUTH-BE-16) — configuration", () => {
  it("never falls back to the calendar/inbox GOOGLE_CLIENT_* app for login", () => {
    const config = makeConfig({
      GOOGLE_OAUTH_CLIENT_ID: undefined,
      GOOGLE_OAUTH_CLIENT_SECRET: undefined,
      GOOGLE_CLIENT_ID: "inbox-client",
      GOOGLE_CLIENT_SECRET: "inbox-secret",
    });
    expect(() => getGoogleOAuthCredentials(config)).toThrow(/not configured/);
  });

  it("refuses to mint state without a real signing secret (no hardcoded fallback)", async () => {
    const config = makeConfig({ AUTH_REFRESH_TOKEN_PEPPER: undefined, INTEGRATION_ENCRYPTION_KEY: undefined });
    await expect(createGoogleOAuthState(config, { verifier: "v", nonce: "n" })).rejects.toMatchObject({
      statusCode: 503,
    });
  });
});

describe("google-auth.service (AUTH-BE-16) — OAuth state", () => {
  const config = makeConfig();

  beforeEach(() => clearConsumedStateIdsForTesting());

  it("round-trips once when the state cookie matches", async () => {
    const { stateId, signedState } = await createGoogleOAuthState(config, { verifier: "v", nonce: "n" });
    expect(await verifyAndConsumeGoogleOAuthState(config, signedState, stateId)).toMatchObject({ verifier: "v" });
  });

  it("requires the state cookie (bound to the browser that started the flow)", async () => {
    const { signedState } = await createGoogleOAuthState(config, { verifier: "v", nonce: "n" });
    expect(await verifyAndConsumeGoogleOAuthState(config, signedState, undefined)).toBeNull();
  });

  it("rejects a state minted for Microsoft", async () => {
    const msState = signOAuthState(
      { p: "microsoft", sid: "abc", v: "v", n: "n", nxt: "/dashboard", t: String(Date.now()) },
      PEPPER
    );
    expect(await verifyAndConsumeGoogleOAuthState(config, msState, "abc")).toBeNull();
  });

  it("still accepts an untagged state minted before the provider tag existed", async () => {
    const legacy = signOAuthState({ sid: "old", v: "v", n: "n", nxt: "/dashboard", t: String(Date.now()) }, PEPPER);
    expect(await verifyAndConsumeGoogleOAuthState(config, legacy, "old")).toMatchObject({ verifier: "v" });
  });
});

describe("google-auth.service (AUTH-BE-16) — no PII in logs", () => {
  const config = makeConfig();
  let key: KeyLike;
  let jwks: ReturnType<typeof createLocalJWKSet>;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256", { extractable: true });
    key = pair.privateKey;
    const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "g-kid", alg: "RS256", use: "sig" };
    jwks = createLocalJWKSet({ keys: [jwk] });
  });

  async function token(claims: Record<string, unknown>, aud = CLIENT_ID) {
    return new SignJWT({ sub: "g-sub", email: "Jane.Doe@gmail.example", email_verified: true, name: "Jane Doe", nonce: "n", ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "g-kid" })
      .setIssuer("https://accounts.google.com")
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(key);
  }

  it("does not log the email, name, or nonce when verification fails", async () => {
    logCalls.length = 0;
    const verify = (t: string) => verifyGoogleIdToken(config, t, "n", { keySet: jwks });
    await expect(verify(await token({}, "other-app"))).rejects.toMatchObject({ statusCode: 401 });
    await expect(verify(await token({ nonce: "attacker-nonce" }))).rejects.toMatchObject({ statusCode: 401 });
    await expect(verify(await token({ email_verified: false }))).rejects.toMatchObject({ statusCode: 403 });

    const output = JSON.stringify(logCalls);
    expect(output).toContain("verifyGoogleIdToken");
    expect(output.toLowerCase()).not.toContain("jane.doe@gmail.example");
    expect(output).not.toContain("Jane Doe");
    expect(output).not.toContain("attacker-nonce");
  });
});
