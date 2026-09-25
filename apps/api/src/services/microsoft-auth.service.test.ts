import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { closeRedis, getRedis } from "../lib/redis.js";
import {
  buildMicrosoftAuthorizationUrl,
  clearConsumedMicrosoftStateIdsForTesting,
  createMicrosoftOAuthState,
  getMicrosoftOAuthCredentials,
  verifyAndConsumeMicrosoftOAuthState,
  verifyMicrosoftIdToken,
} from "./microsoft-auth.service.js";

const CLIENT_ID = "11111111-aaaa-4bbb-8ccc-222222222222";
const TID = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const OTHER_TID = "9188040d-6c67-4c5b-b112-36a304b66dad";
const OID = "00000000-0000-0000-66f3-3332eca7ea81";
const PEPPER = "test-pepper-do-not-use-in-prod";

function makeConfig(overrides: Partial<Env> = {}): Env {
  return {
    ...loadEnv(),
    REDIS_URL: "",
    AUTH_REFRESH_TOKEN_PEPPER: PEPPER,
    MICROSOFT_OAUTH_CLIENT_ID: CLIENT_ID,
    MICROSOFT_OAUTH_CLIENT_SECRET: "test-ms-secret",
    MICROSOFT_OAUTH_TENANT: "common",
    FRONTEND_URL: "https://app.example.test",
    ...overrides,
  };
}

let signingKey: KeyLike;
let otherKey: KeyLike;
let jwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  signingKey = pair.privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "ms-test-kid", alg: "RS256", use: "sig" };
  jwks = createLocalJWKSet({ keys: [jwk] });
  otherKey = (await generateKeyPair("RS256")).privateKey;
});

async function idToken(
  claims: Record<string, unknown> = {},
  opts: { iss?: string; aud?: string; key?: KeyLike; exp?: string } = {}
): Promise<string> {
  const tid = (claims.tid as string | undefined) ?? TID;
  return new SignJWT({
    tid,
    oid: OID,
    email: "Jane.Doe@Contoso.example",
    xms_edov: true,
    name: "Jane Doe",
    nonce: "expected-nonce",
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "ms-test-kid" })
    .setIssuer(opts.iss ?? `https://login.microsoftonline.com/${tid}/v2.0`)
    .setAudience(opts.aud ?? CLIENT_ID)
    .setSubject("pairwise-sub")
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "5m")
    .sign(opts.key ?? signingKey);
}

describe("microsoft-auth.service (AUTH-BE-16 Microsoft) — configuration", () => {
  it("requires the dedicated login client and never falls back to the inbox MICROSOFT_CLIENT_*", () => {
    const config = makeConfig({
      MICROSOFT_OAUTH_CLIENT_ID: undefined,
      MICROSOFT_OAUTH_CLIENT_SECRET: undefined,
      MICROSOFT_CLIENT_ID: "inbox-client",
      MICROSOFT_CLIENT_SECRET: "inbox-secret",
    });
    expect(() => getMicrosoftOAuthCredentials(config)).toThrow(/not configured/);
  });

  it("builds an authorization URL with PKCE, nonce, state, and login-only scopes", () => {
    const url = new URL(
      buildMicrosoftAuthorizationUrl(makeConfig(), { state: "s", challenge: "c", nonce: "n" })
    );
    expect(url.origin + url.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("code_challenge")).toBe("c");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("s");
    expect(url.searchParams.get("nonce")).toBe("n");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example.test/api/auth/microsoft/callback");
  });
});

describe("microsoft-auth.service (AUTH-BE-16 Microsoft) — OAuth state", () => {
  const config = makeConfig();

  beforeEach(() => clearConsumedMicrosoftStateIdsForTesting());

  async function newState(next?: string) {
    return createMicrosoftOAuthState(config, { verifier: "verifier-1", nonce: "nonce-1", next });
  }

  it("round-trips once, bound to the browser cookie", async () => {
    const { stateId, signedState } = await newState("/settings");
    await expect(verifyAndConsumeMicrosoftOAuthState(config, signedState, stateId)).resolves.toEqual({
      verifier: "verifier-1",
      nonce: "nonce-1",
      next: "/settings",
    });
  });

  it("rejects a replayed state", async () => {
    const { stateId, signedState } = await newState();
    expect(await verifyAndConsumeMicrosoftOAuthState(config, signedState, stateId)).not.toBeNull();
    expect(await verifyAndConsumeMicrosoftOAuthState(config, signedState, stateId)).toBeNull();
  });

  it("rejects a missing or mismatched state cookie", async () => {
    const { signedState } = await newState();
    expect(await verifyAndConsumeMicrosoftOAuthState(config, signedState, undefined)).toBeNull();
    expect(await verifyAndConsumeMicrosoftOAuthState(config, signedState, "someone-elses-state")).toBeNull();
  });

  it("rejects a tampered state and a state signed with another secret", async () => {
    const { stateId, signedState } = await newState();
    expect(await verifyAndConsumeMicrosoftOAuthState(config, `${signedState}x`, stateId)).toBeNull();
    const other = makeConfig({ AUTH_REFRESH_TOKEN_PEPPER: "a-different-pepper" });
    expect(await verifyAndConsumeMicrosoftOAuthState(other, signedState, stateId)).toBeNull();
  });

  it("rejects a validly signed state minted for Google (no provider tag)", async () => {
    const googleState = signOAuthState(
      { sid: "abc", v: "verifier", n: "nonce", nxt: "/dashboard", t: String(Date.now()) },
      PEPPER
    );
    expect(await verifyAndConsumeMicrosoftOAuthState(config, googleState, "abc")).toBeNull();
  });

  it("rejects an expired state", async () => {
    const stale = signOAuthState(
      { p: "microsoft", sid: "old", v: "v", n: "n", nxt: "/dashboard", t: String(Date.now() - 11 * 60 * 1000) },
      PEPPER
    );
    expect(await verifyAndConsumeMicrosoftOAuthState(config, stale, "old")).toBeNull();
  });

  it("never carries an unsafe redirect target through the state", async () => {
    const { stateId, signedState } = await newState("https://evil.example/steal");
    const result = await verifyAndConsumeMicrosoftOAuthState(config, signedState, stateId);
    expect(result?.next).toBe("/dashboard");
  });
});

describe("microsoft-auth.service (AUTH-BE-16 Microsoft) — ID token verification", () => {
  const config = makeConfig();
  const verify = (token: string, cfg: Env = config) =>
    verifyMicrosoftIdToken(cfg, token, "expected-nonce", { keySet: jwks });

  it("accepts a valid token and returns tid:oid as the subject with a normalized email", async () => {
    await expect(verify(await idToken())).resolves.toEqual({
      subject: `${TID}:${OID}`,
      email: "jane.doe@contoso.example",
      emailVerified: true,
      name: "Jane Doe",
    });
  });

  it("accepts xms_edov sent as a string or 1", async () => {
    await expect(verify(await idToken({ xms_edov: "true" }))).resolves.toMatchObject({ emailVerified: true });
    await expect(verify(await idToken({ xms_edov: 1 }))).resolves.toMatchObject({ emailVerified: true });
  });

  it("refuses an unverified email (xms_edov false or absent) with 403 — Ground Rule 5", async () => {
    await expect(verify(await idToken({ xms_edov: false }))).rejects.toMatchObject({ statusCode: 403 });
    await expect(verify(await idToken({ xms_edov: undefined }))).rejects.toMatchObject({ statusCode: 403 });
  });

  it("refuses a token with no email claim (never falls back to preferred_username)", async () => {
    await expect(
      verify(await idToken({ email: undefined, preferred_username: "victim@contoso.example" }))
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("rejects a nonce mismatch", async () => {
    await expect(verify(await idToken({ nonce: "other" }))).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects the wrong audience", async () => {
    await expect(verify(await idToken({}, { aud: "some-other-app" }))).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects an issuer that does not match the token's own tenant", async () => {
    const token = await idToken({}, { iss: `https://login.microsoftonline.com/${OTHER_TID}/v2.0` });
    await expect(verify(token)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects a non-Microsoft issuer", async () => {
    await expect(verify(await idToken({}, { iss: "https://evil.example/v2.0" }))).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it("rejects a token from another tenant when a specific tenant is configured", async () => {
    const tenantConfig = makeConfig({ MICROSOFT_OAUTH_TENANT: OTHER_TID });
    await expect(verify(await idToken(), tenantConfig)).rejects.toMatchObject({ statusCode: 401 });
    await expect(verify(await idToken({ tid: OTHER_TID }), tenantConfig)).resolves.toMatchObject({
      subject: `${OTHER_TID}:${OID}`,
    });
  });

  it("rejects a missing or malformed tenant id", async () => {
    await expect(verify(await idToken({ tid: "not-a-guid" }))).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects a missing object id", async () => {
    await expect(verify(await idToken({ oid: undefined }))).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects an expired token", async () => {
    await expect(verify(await idToken({}, { exp: "-1m" }))).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects a token signed with an unknown key", async () => {
    await expect(verify(await idToken({}, { key: otherKey }))).rejects.toMatchObject({ statusCode: 401 });
  });

  it("does not write the token's email or name to the logs when verification fails", async () => {
    logCalls.length = 0;
    await expect(verify(await idToken({}, { aud: "some-other-app" }))).rejects.toMatchObject({ statusCode: 401 });
    await expect(verify(await idToken({ xms_edov: false }))).rejects.toMatchObject({ statusCode: 403 });
    const output = JSON.stringify(logCalls, (_k, v) => (v instanceof Error ? { ...v, message: v.message } : v));
    expect(output).toContain("verifyMicrosoftIdToken");
    expect(output.toLowerCase()).not.toContain("jane.doe@contoso.example");
    expect(output).not.toContain("Jane Doe");
  });

  it("rejects alg:none and HS256 tokens", async () => {
    const payload = Buffer.from(
      JSON.stringify({
        tid: TID,
        oid: OID,
        email: "a@b.example",
        xms_edov: true,
        nonce: "expected-nonce",
        iss: `https://login.microsoftonline.com/${TID}/v2.0`,
        aud: CLIENT_ID,
        exp: Math.floor(Date.now() / 1000) + 300,
      })
    ).toString("base64url");
    const none = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${payload}.`;
    await expect(verify(none)).rejects.toMatchObject({ statusCode: 401 });

    const hs = await new SignJWT({ tid: TID, oid: OID, email: "a@b.example", xms_edov: true, nonce: "expected-nonce" })
      .setProtectedHeader({ alg: "HS256", kid: "ms-test-kid" })
      .setIssuer(`https://login.microsoftonline.com/${TID}/v2.0`)
      .setAudience(CLIENT_ID)
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("shared-secret-shared-secret-32bytes!"));
    await expect(verify(hs)).rejects.toMatchObject({ statusCode: 401 });
  });
});

// Runs only where a Redis is reachable (e.g. local dev with REDIS_URL set); CI has no Redis.
describe.skipIf(!process.env.REDIS_URL)("microsoft-auth.service (AUTH-BE-16 Microsoft) — OAuth state with Redis", () => {
  const config = makeConfig({ REDIS_URL: process.env.REDIS_URL ?? "" });

  afterAll(async () => {
    await closeRedis();
  });

  it("stores the state in Redis with a TTL and deletes it on use", async () => {
    const redis = getRedis(config);
    expect(redis).not.toBeNull();
    const { stateId, signedState } = await createMicrosoftOAuthState(config, { verifier: "v", nonce: "n" });
    const key = `auth:oauth:microsoft:${stateId}`;
    expect(await redis!.exists(key)).toBe(1);
    const ttl = await redis!.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(10 * 60);

    expect(await verifyAndConsumeMicrosoftOAuthState(config, signedState, stateId)).not.toBeNull();
    expect(await redis!.exists(key)).toBe(0);
  });

  it("rejects a replay on another API instance (fresh in-memory cache) because Redis already consumed it", async () => {
    const { stateId, signedState } = await createMicrosoftOAuthState(config, { verifier: "v", nonce: "n" });
    expect(await verifyAndConsumeMicrosoftOAuthState(config, signedState, stateId)).not.toBeNull();
    clearConsumedMicrosoftStateIdsForTesting(); // simulate a different process
    expect(await verifyAndConsumeMicrosoftOAuthState(config, signedState, stateId)).toBeNull();
  });
});
