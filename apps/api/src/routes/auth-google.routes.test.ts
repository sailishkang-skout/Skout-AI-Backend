import { generateKeyPair, exportJWK, exportPKCS8, SignJWT, createLocalJWKSet } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, schema } from "@skout/db";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { loadEnv } from "../config/env.js";
import { buildAuthCoreProbeApp } from "../test/auth-core-probe-app.js";
import { closeRedis, getRedis } from "../lib/redis.js";
import {
  setGoogleRemoteJwks,
  resetGoogleRemoteJwks,
  clearConsumedStateIdsForTesting,
  GOOGLE_STATE_COOKIE_NAME,
} from "../services/google-auth.service.js";

const { users, authSessions, authEvents, workspaceMembers, workspaces, creditBalances, authIdentities } = schema;

const TEST_GOOGLE_CLIENT_ID = "test-google-client-id-123.apps.googleusercontent.com";
const TEST_GOOGLE_CLIENT_SECRET = "test-google-client-secret-xyz";

let googleSigningKey: { pem: string; jwk: any; key: any };

const mockTokenExchange = vi.hoisted(() => ({
  idToken: "" as string,
}));

vi.mock("../services/google-auth.service.js", async () => {
  const actual = await vi.importActual<typeof import("../services/google-auth.service.js")>(
    "../services/google-auth.service.js"
  );
  return {
    ...actual,
    exchangeGoogleCode: vi.fn(async () => {
      return { id_token: mockTokenExchange.idToken, access_token: "mock-access-token" };
    }),
  };
});

function cookieValue(response: { cookies: Array<{ name: string; value: string }> }, name: string): string | undefined {
  return response.cookies.find((c) => c.name === name)?.value;
}

async function makeTestSigningKey() {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-auth-kid";
  jwk.alg = "RS256";
  jwk.use = "sig";
  const pem = await exportPKCS8(privateKey);
  return { pem, jwk };
}

async function makeTestGoogleKey() {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = "google-test-kid-1";
  jwk.alg = "RS256";
  jwk.use = "sig";
  const pem = await exportPKCS8(privateKey);
  return { pem, jwk, key: privateKey };
}

async function signTestGoogleIdToken(opts: {
  sub?: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  nonce?: string;
  aud?: string;
  iss?: string;
  expiresIn?: string;
}) {
  const jwt = new SignJWT({
    sub: opts.sub ?? "google-user-sub-123",
    email: opts.email ?? "google-test-user@example.test",
    email_verified: opts.emailVerified ?? true,
    name: opts.name ?? "Google Test User",
    nonce: opts.nonce ?? "test-nonce",
    picture: "https://example.test/photo.jpg",
  })
    .setProtectedHeader({ alg: "RS256", kid: "google-test-kid-1" })
    .setIssuedAt()
    .setIssuer(opts.iss ?? "https://accounts.google.com")
    .setAudience(opts.aud ?? TEST_GOOGLE_CLIENT_ID)
    .setExpirationTime(opts.expiresIn ?? "1h");

  return jwt.sign(googleSigningKey.key);
}

describe("auth-google.routes (AUTH-BE-16)", () => {
  const config = {
    ...loadEnv(),
    AUTH_REFRESH_TOKEN_PEPPER: "test-pepper-do-not-use-in-prod",
    GOOGLE_OAUTH_CLIENT_ID: TEST_GOOGLE_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: TEST_GOOGLE_CLIENT_SECRET,
  };
  const { db, sql } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
  const createdUserEmails: string[] = [];
  let app: FastifyInstance;

  async function clearRecoveryRedisKeys(): Promise<void> {
    try {
      const redis = getRedis(config);
      if (!redis) return;
      const keys = await redis.keys("auth:oauth:google:*");
      if (keys.length > 0) await redis.del(...keys);
    } catch {
      // Redis unavailable in CI
    }
  }

  beforeAll(async () => {
    await clearRecoveryRedisKeys();
    const ownKey = await makeTestSigningKey();
    googleSigningKey = await makeTestGoogleKey();

    // Hook Google JWKS resolution to our local test key
    setGoogleRemoteJwks(createLocalJWKSet({ keys: [googleSigningKey.jwk] }));

    app = await buildAuthCoreProbeApp(db, {
      AUTH_REFRESH_TOKEN_PEPPER: config.AUTH_REFRESH_TOKEN_PEPPER,
      AUTH_JWT_PRIVATE_KEY: ownKey.pem,
      AUTH_JWT_KID: "test-auth-kid",
      AUTH_JWT_PUBLIC_KEY_SET: JSON.stringify({ keys: [ownKey.jwk] }),
      GOOGLE_OAUTH_CLIENT_ID: TEST_GOOGLE_CLIENT_ID,
      GOOGLE_OAUTH_CLIENT_SECRET: TEST_GOOGLE_CLIENT_SECRET,
      NODE_ENV: "test",
    });
  });

  afterEach(async () => {
    clearConsumedStateIdsForTesting();
    await clearRecoveryRedisKeys();
    for (const email of createdUserEmails) {
      const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
      if (!user) continue;
      await db.delete(authEvents).where(eq(authEvents.userId, user.id));
      await db.delete(authIdentities).where(eq(authIdentities.userId, user.id));
      const sessions = await db.select({ id: authSessions.id }).from(authSessions).where(eq(authSessions.userId, user.id));
      for (const s of sessions) {
        await db.delete(schema.authRefreshTokens).where(eq(schema.authRefreshTokens.sessionId, s.id));
      }
      await db.delete(authSessions).where(eq(authSessions.userId, user.id));
      const memberships = await db
        .select({ workspaceId: workspaceMembers.workspaceId })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, user.id));
      await db.delete(schema.userCredentials).where(eq(schema.userCredentials.userId, user.id));
      await db.delete(workspaceMembers).where(eq(workspaceMembers.userId, user.id));
      await db.delete(users).where(eq(users.id, user.id));
      for (const m of memberships) {
        await db.delete(creditBalances).where(eq(creditBalances.workspaceId, m.workspaceId));
        await db.delete(schema.creditTransactions).where(eq(schema.creditTransactions.workspaceId, m.workspaceId));
        await db.delete(workspaces).where(eq(workspaces.id, m.workspaceId));
      }
    }
    createdUserEmails.length = 0;
  });

  afterAll(async () => {
    resetGoogleRemoteJwks();
    await app?.close();
    await closeRedis();
    await sql.end();
  });

  function freshEmail(label: string): string {
    const email = `be16-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
    createdUserEmails.push(email);
    return email;
  }

  it("404s when AUTH_CUSTOM_ENABLED is false", async () => {
    const offApp = await buildAuthCoreProbeApp(db, {
      AUTH_CUSTOM_ENABLED: false,
      AUTH_REFRESH_TOKEN_PEPPER: config.AUTH_REFRESH_TOKEN_PEPPER,
      NODE_ENV: "test",
    });

    const startRes = await offApp.inject({ method: "GET", url: "/api/v1/auth/google/start" });
    expect(startRes.statusCode).toBe(404);

    const callbackRes = await offApp.inject({
      method: "POST",
      url: "/api/v1/auth/google/callback",
      payload: { code: "any-code", state: "any-state" },
    });
    expect(callbackRes.statusCode).toBe(404);

    await offApp.close();
  });

  it("start endpoint returns authorization URL, PKCE challenge, state, and sets state cookie", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/google/start?next=/onboarding",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data?.authorizationUrl).toBeTruthy();
    expect(body.data?.state).toBeTruthy();

    const authUrl = new URL(body.data.authorizationUrl);
    expect(authUrl.origin + authUrl.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(authUrl.searchParams.get("client_id")).toBe(TEST_GOOGLE_CLIENT_ID);
    expect(authUrl.searchParams.get("response_type")).toBe("code");
    expect(authUrl.searchParams.get("scope")).toBe("openid email profile");
    expect(authUrl.searchParams.get("code_challenge")).toBeTruthy();
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("nonce")).toBeTruthy();
    expect(authUrl.searchParams.get("state")).toBe(body.data.state);

    const stateCookie = cookieValue(res, GOOGLE_STATE_COOKIE_NAME);
    expect(stateCookie).toBeTruthy();
  });

  it("open-redirect safety: next parameter is sanitized to internal path", async () => {
    const evilRes = await app.inject({
      method: "GET",
      url: "/api/v1/auth/google/start?next=https://evil.com",
    });
    expect(evilRes.statusCode).toBe(200);

    const schemeRes = await app.inject({
      method: "GET",
      url: "/api/v1/auth/google/start?next=//evil.com",
    });
    expect(schemeRes.statusCode).toBe(200);
  });

  it("callback rejects forged or tampered state", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/google/callback",
      payload: { code: "some-code", state: "forged.state.signature" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("AUTH_TOKEN_INVALID");
  });

  it("callback rejects replayed state (single-use guarantee)", async () => {
    const email = freshEmail("replay");
    const startRes = await app.inject({ method: "GET", url: "/api/v1/auth/google/start" });
    const { state, authorizationUrl } = startRes.json().data;
    const authUrl = new URL(authorizationUrl);
    const nonce = authUrl.searchParams.get("nonce")!;
    const stateCookie = cookieValue(startRes, GOOGLE_STATE_COOKIE_NAME);

    mockTokenExchange.idToken = await signTestGoogleIdToken({
      email,
      sub: "google-sub-replay",
      nonce,
    });

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/auth/google/callback",
      headers: { cookie: `${GOOGLE_STATE_COOKIE_NAME}=${stateCookie}` },
      payload: { code: "valid-auth-code", state },
    });
    expect(first.statusCode).toBe(200);

    // Replay with identical state
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/auth/google/callback",
      headers: { cookie: `${GOOGLE_STATE_COOKIE_NAME}=${stateCookie}` },
      payload: { code: "valid-auth-code", state },
    });
    expect(second.statusCode).toBe(401);
    expect(second.json().code).toBe("AUTH_TOKEN_INVALID");
  });

  it("callback rejects mismatched nonce in ID token", async () => {
    const email = freshEmail("bad-nonce");
    const startRes = await app.inject({ method: "GET", url: "/api/v1/auth/google/start" });
    const { state } = startRes.json().data;
    const stateCookie = cookieValue(startRes, GOOGLE_STATE_COOKIE_NAME);

    mockTokenExchange.idToken = await signTestGoogleIdToken({
      email,
      sub: "google-sub-bad-nonce",
      nonce: "wrong-unexpected-nonce",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/google/callback",
      headers: { cookie: `${GOOGLE_STATE_COOKIE_NAME}=${stateCookie}` },
      payload: { code: "valid-code", state },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("AUTH_TOKEN_INVALID");
  });

  it("callback rejects email_verified === false (Ground Rule 5)", async () => {
    const email = freshEmail("unverified");
    const startRes = await app.inject({ method: "GET", url: "/api/v1/auth/google/start" });
    const { state, authorizationUrl } = startRes.json().data;
    const authUrl = new URL(authorizationUrl);
    const nonce = authUrl.searchParams.get("nonce")!;
    const stateCookie = cookieValue(startRes, GOOGLE_STATE_COOKIE_NAME);

    mockTokenExchange.idToken = await signTestGoogleIdToken({
      email,
      sub: "google-sub-unverified",
      emailVerified: false,
      nonce,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/google/callback",
      headers: { cookie: `${GOOGLE_STATE_COOKIE_NAME}=${stateCookie}` },
      payload: { code: "valid-code", state },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("AUTH_EMAIL_NOT_VERIFIED");
  });

  it("callback links existing user by verified email without duplicate user creation", async () => {
    const email = freshEmail("linked");
    // Pre-create user via email/password signup
    const signupRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/signup",
      payload: { email, password: "correct horse battery staple", fullName: "Original Name" },
    });
    expect(signupRes.statusCode).toBe(201);
    const existingUserId = signupRes.json().data.userId;

    const startRes = await app.inject({ method: "GET", url: "/api/v1/auth/google/start" });
    const { state, authorizationUrl } = startRes.json().data;
    const authUrl = new URL(authorizationUrl);
    const nonce = authUrl.searchParams.get("nonce")!;
    const stateCookie = cookieValue(startRes, GOOGLE_STATE_COOKIE_NAME);

    const googleSub = `google-sub-${Date.now()}`;
    mockTokenExchange.idToken = await signTestGoogleIdToken({
      email,
      sub: googleSub,
      name: "Google Linked Name",
      nonce,
    });

    const callbackRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/google/callback",
      headers: { cookie: `${GOOGLE_STATE_COOKIE_NAME}=${stateCookie}` },
      payload: { code: "valid-code", state },
    });

    expect(callbackRes.statusCode).toBe(200);
    const callbackData = callbackRes.json().data;
    expect(callbackData.user.id).toBe(existingUserId);
    expect(callbackData.accessToken).toBeTruthy();
    expect(cookieValue(callbackRes, "skout_refresh")).toBeTruthy();

    // Verify auth_identities link
    const [identity] = await db
      .select({ provider: authIdentities.provider, providerSubject: authIdentities.providerSubject })
      .from(authIdentities)
      .where(and(eq(authIdentities.userId, existingUserId), eq(authIdentities.provider, "google")))
      .limit(1);
    expect(identity?.provider).toBe("google");
    expect(identity?.providerSubject).toBe(googleSub);
  });

  it("callback provisions new user with workspace and 500 initial credits", async () => {
    const email = freshEmail("provision");
    const startRes = await app.inject({ method: "GET", url: "/api/v1/auth/google/start" });
    const { state, authorizationUrl } = startRes.json().data;
    const authUrl = new URL(authorizationUrl);
    const nonce = authUrl.searchParams.get("nonce")!;
    const stateCookie = cookieValue(startRes, GOOGLE_STATE_COOKIE_NAME);

    mockTokenExchange.idToken = await signTestGoogleIdToken({
      email,
      sub: `google-sub-new-${Date.now()}`,
      name: "New Provisioned User",
      nonce,
    });

    const callbackRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/google/callback",
      headers: { cookie: `${GOOGLE_STATE_COOKIE_NAME}=${stateCookie}` },
      payload: { code: "valid-code", state },
    });

    expect(callbackRes.statusCode).toBe(200);
    const data = callbackRes.json().data;
    expect(data.user.email).toBe(email);
    expect(data.user.workspaceId).toBeTruthy();
    expect(data.accessToken).toBeTruthy();
    expect(cookieValue(callbackRes, "skout_refresh")).toBeTruthy();

    // Verify 500 initial credits
    const [balance] = await db
      .select({ balance: creditBalances.balance })
      .from(creditBalances)
      .where(eq(creditBalances.workspaceId, data.user.workspaceId))
      .limit(1);
    expect(balance?.balance).toBe(500);
  });

  it("callback refuses blocked user with 403 AUTH_ACCOUNT_BLOCKED", async () => {
    const email = freshEmail("blocked");
    // Pre-create user and set blocked
    const signupRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/signup",
      payload: { email, password: "correct horse battery staple" },
    });
    const userId = signupRes.json().data.userId;
    await db.update(users).set({ isBlocked: true }).where(eq(users.id, userId));

    const startRes = await app.inject({ method: "GET", url: "/api/v1/auth/google/start" });
    const { state, authorizationUrl } = startRes.json().data;
    const authUrl = new URL(authorizationUrl);
    const nonce = authUrl.searchParams.get("nonce")!;
    const stateCookie = cookieValue(startRes, GOOGLE_STATE_COOKIE_NAME);

    mockTokenExchange.idToken = await signTestGoogleIdToken({
      email,
      sub: `google-sub-blocked-${Date.now()}`,
      nonce,
    });

    const callbackRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/google/callback",
      headers: { cookie: `${GOOGLE_STATE_COOKIE_NAME}=${stateCookie}` },
      payload: { code: "valid-code", state },
    });

    expect(callbackRes.statusCode).toBe(403);
    expect(callbackRes.json().code).toBe("AUTH_ACCOUNT_BLOCKED");
  });
});

