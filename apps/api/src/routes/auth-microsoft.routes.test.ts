import { createLocalJWKSet, exportJWK, exportPKCS8, generateKeyPair, SignJWT, type JWK, type KeyLike } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@skout/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { loadEnv, type Env } from "../config/env.js";
import { buildAuthCoreProbeApp } from "../test/auth-core-probe-app.js";
import {
  MICROSOFT_STATE_COOKIE_NAME,
  clearConsumedMicrosoftStateIdsForTesting,
  resetMicrosoftRemoteJwks,
  setMicrosoftRemoteJwks,
} from "../services/microsoft-auth.service.js";

const { users, authSessions, authEvents, workspaceMembers, workspaces, creditBalances, authIdentities } = schema;

const CLIENT_ID = "11111111-aaaa-4bbb-8ccc-222222222222";
const TID = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const PEPPER = "test-pepper-do-not-use-in-prod";

const exchange = vi.hoisted(() => ({ idToken: "", fail: false }));

vi.mock("../services/microsoft-auth.service.js", async () => {
  const actual = await vi.importActual<typeof import("../services/microsoft-auth.service.js")>(
    "../services/microsoft-auth.service.js"
  );
  return {
    ...actual,
    exchangeMicrosoftCode: vi.fn(async () => {
      if (exchange.fail) throw new Error("token endpoint said no");
      return { id_token: exchange.idToken };
    }),
  };
});

let msKey: KeyLike;
let ownKey: { pem: string; jwk: JWK };

beforeAll(async () => {
  const ms = await generateKeyPair("RS256", { extractable: true });
  msKey = ms.privateKey;
  const msJwk: JWK = { ...(await exportJWK(ms.publicKey)), kid: "ms-test-kid", alg: "RS256", use: "sig" };
  setMicrosoftRemoteJwks(createLocalJWKSet({ keys: [msJwk] }));

  const own = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
  ownKey = {
    pem: await exportPKCS8(own.privateKey),
    jwk: { ...(await exportJWK(own.publicKey)), kid: "test-auth-kid", alg: "RS256", use: "sig" },
  };
});

afterAll(() => {
  resetMicrosoftRemoteJwks();
});

afterEach(() => {
  clearConsumedMicrosoftStateIdsForTesting();
  exchange.idToken = "";
  exchange.fail = false;
});

function appOverrides(extra: Partial<Env> = {}): Partial<Env> {
  return {
    REDIS_URL: "",
    NODE_ENV: "test",
    AUTH_REFRESH_TOKEN_PEPPER: PEPPER,
    AUTH_JWT_PRIVATE_KEY: ownKey.pem,
    AUTH_JWT_KID: "test-auth-kid",
    AUTH_JWT_PUBLIC_KEY_SET: JSON.stringify({ keys: [ownKey.jwk] }),
    MICROSOFT_OAUTH_CLIENT_ID: CLIENT_ID,
    MICROSOFT_OAUTH_CLIENT_SECRET: "test-ms-secret",
    MICROSOFT_OAUTH_TENANT: "common",
    ...extra,
  };
}

async function msIdToken(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT({ tid: TID, name: "MS Test User", xms_edov: true, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "ms-test-kid" })
    .setIssuer(`https://login.microsoftonline.com/${TID}/v2.0`)
    .setAudience(CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(msKey);
}

/** Runs /start and returns what a browser would carry into /callback. */
async function startFlow(app: FastifyInstance, next?: string) {
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/auth/microsoft/start${next ? `?next=${encodeURIComponent(next)}` : ""}`,
  });
  expect(res.statusCode).toBe(200);
  const url = new URL(res.json().data.authorizationUrl);
  const stateId = res.cookies.find((c) => c.name === MICROSOFT_STATE_COOKIE_NAME)?.value;
  return { state: url.searchParams.get("state")!, nonce: url.searchParams.get("nonce")!, stateId: stateId! };
}

function callback(app: FastifyInstance, flow: { state: string; stateId?: string }) {
  return app.inject({
    method: "POST",
    url: "/api/v1/auth/microsoft/callback",
    payload: { code: "auth-code", state: flow.state },
    cookies: flow.stateId ? { [MICROSOFT_STATE_COOKIE_NAME]: flow.stateId } : {},
  });
}

describe("auth-microsoft.routes (AUTH-BE-16 Microsoft) — no database needed", () => {
  // Every path here is decided before the database is touched (logEvent failures are swallowed).
  const fakeDb = {} as Db;
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildAuthCoreProbeApp(fakeDb, appOverrides());
  });

  afterAll(async () => {
    await app.close();
  });

  it("404s both routes when AUTH_CUSTOM_ENABLED is false", async () => {
    const offApp = await buildAuthCoreProbeApp(fakeDb, appOverrides({ AUTH_CUSTOM_ENABLED: false }));
    expect((await offApp.inject({ method: "GET", url: "/api/v1/auth/microsoft/start" })).statusCode).toBe(404);
    expect((await callback(offApp, { state: "x" })).statusCode).toBe(404);
    await offApp.close();
  });

  it("503s when only the inbox Microsoft app is configured", async () => {
    const noLoginApp = await buildAuthCoreProbeApp(
      fakeDb,
      appOverrides({
        MICROSOFT_OAUTH_CLIENT_ID: undefined,
        MICROSOFT_OAUTH_CLIENT_SECRET: undefined,
        MICROSOFT_CLIENT_ID: "inbox-client",
        MICROSOFT_CLIENT_SECRET: "inbox-secret",
      })
    );
    expect((await noLoginApp.inject({ method: "GET", url: "/api/v1/auth/microsoft/start" })).statusCode).toBe(503);
    expect((await callback(noLoginApp, { state: "x" })).statusCode).toBe(503);
    await noLoginApp.close();
  });

  it("start returns a PKCE authorization URL and sets an HttpOnly state cookie", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/microsoft/start?next=/onboarding" });
    expect(res.statusCode).toBe(200);
    const url = new URL(res.json().data.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("nonce")).toBeTruthy();
    const cookie = res.cookies.find((c) => c.name === MICROSOFT_STATE_COOKIE_NAME);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.path).toBe("/api/v1/auth");
  });

  it("start redirects when asked to", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/microsoft/start?redirect=true" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^https:\/\/login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/authorize\?/);
  });

  it("rejects a malformed callback body with 400", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/microsoft/callback", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a forged state, a missing state cookie, and a replayed state", async () => {
    expect((await callback(app, { state: "forged.state", stateId: "abc" })).json().code).toBe("AUTH_TOKEN_INVALID");

    const noCookie = await startFlow(app);
    const res = await callback(app, { state: noCookie.state });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("AUTH_TOKEN_INVALID");

    const flow = await startFlow(app);
    exchange.fail = true; // consume the state without needing the database
    expect((await callback(app, flow)).statusCode).toBe(401);
    const replay = await callback(app, flow);
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error).toMatch(/state/i);
  });

  it("returns 401 when the code exchange fails", async () => {
    const flow = await startFlow(app);
    exchange.fail = true;
    const res = await callback(app, flow);
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("AUTH_TOKEN_INVALID");
  });

  it("refuses an unverified Microsoft email with 403 AUTH_EMAIL_NOT_VERIFIED", async () => {
    const flow = await startFlow(app);
    exchange.idToken = await msIdToken({ oid: "oid-1", email: "x@contoso.example", xms_edov: false, nonce: flow.nonce });
    const res = await callback(app, flow);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("AUTH_EMAIL_NOT_VERIFIED");
  });

  it("rejects an ID token whose nonce doesn't match the one sent at start", async () => {
    const flow = await startFlow(app);
    exchange.idToken = await msIdToken({ oid: "oid-1", email: "x@contoso.example", nonce: "some-other-nonce" });
    const res = await callback(app, flow);
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("AUTH_TOKEN_INVALID");
  });
});

describe("auth-microsoft.routes (AUTH-BE-16 Microsoft) — with database", () => {
  const config = loadEnv();
  const { db, sql } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
  const createdUserEmails: string[] = [];
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildAuthCoreProbeApp(db, appOverrides());
  });

  afterEach(async () => {
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
    await app?.close();
    await sql.end();
  });

  function freshEmail(label: string): string {
    const email = `be16ms-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
    createdUserEmails.push(email);
    return email;
  }

  function freshOid(): string {
    return `00000000-0000-0000-${Math.random().toString(16).slice(2, 6)}-${Date.now().toString(16).padStart(12, "0").slice(-12)}`;
  }

  it("provisions a new user with workspace + credits, links a microsoft identity, and issues a session", async () => {
    const email = freshEmail("new");
    const oid = freshOid();
    const flow = await startFlow(app, "/onboarding");
    exchange.idToken = await msIdToken({ oid, email, nonce: flow.nonce });

    const res = await callback(app, flow);
    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    expect(body.accessToken).toBeTruthy();
    expect(body.next).toBe("/onboarding");
    expect(res.cookies.find((c) => c.name === "skout_refresh")?.httpOnly).toBe(true);

    const [identity] = await db.select().from(authIdentities).where(eq(authIdentities.userId, body.user.id));
    expect(identity?.provider).toBe("microsoft");
    expect(identity?.providerSubject).toBe(`${TID}:${oid}`);
    expect(identity?.emailVerifiedAt).toBeTruthy();

    const [membership] = await db
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, body.user.id));
    expect(membership).toBeTruthy();
    const [credits] = await db.select().from(creditBalances).where(eq(creditBalances.workspaceId, membership!.workspaceId));
    expect(credits).toBeTruthy();
  });

  it("links to an existing user with the same verified email instead of creating a duplicate", async () => {
    const email = freshEmail("existing");
    const [existing] = await db
      .insert(users)
      .values({ email, fullName: "Existing User", status: "active" })
      .returning({ id: users.id });

    const flow = await startFlow(app);
    exchange.idToken = await msIdToken({ oid: freshOid(), email: email.toUpperCase(), nonce: flow.nonce });
    const res = await callback(app, flow);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.user.id).toBe(existing!.id);

    const all = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    expect(all).toHaveLength(1);
  });

  it("signs the same Microsoft identity back into the same user", async () => {
    const email = freshEmail("repeat");
    const oid = freshOid();
    const first = await startFlow(app);
    exchange.idToken = await msIdToken({ oid, email, nonce: first.nonce });
    const firstRes = await callback(app, first);
    expect(firstRes.statusCode).toBe(200);

    const second = await startFlow(app);
    exchange.idToken = await msIdToken({ oid, email, nonce: second.nonce });
    const secondRes = await callback(app, second);
    expect(secondRes.statusCode).toBe(200);
    expect(secondRes.json().data.user.id).toBe(firstRes.json().data.user.id);
  });

  it("refuses a blocked user with 403 AUTH_ACCOUNT_BLOCKED and issues no session", async () => {
    const email = freshEmail("blocked");
    const [blocked] = await db
      .insert(users)
      .values({ email, fullName: "Blocked User", status: "active", isBlocked: true })
      .returning({ id: users.id });

    const flow = await startFlow(app);
    exchange.idToken = await msIdToken({ oid: freshOid(), email, nonce: flow.nonce });
    const res = await callback(app, flow);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("AUTH_ACCOUNT_BLOCKED");
    expect(res.cookies.find((c) => c.name === "skout_refresh")).toBeUndefined();

    const sessions = await db.select().from(authSessions).where(eq(authSessions.userId, blocked!.id));
    expect(sessions).toHaveLength(0);
  });
});
