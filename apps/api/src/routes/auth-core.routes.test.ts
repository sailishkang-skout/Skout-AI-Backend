import { generateKeyPair, exportJWK, exportPKCS8 } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, schema } from "@skout/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { loadEnv } from "../config/env.js";
import { buildAuthCoreProbeApp } from "../test/auth-core-probe-app.js";

const { users, userCredentials, authSessions, authEvents, workspaceMembers, workspaces, creditBalances, authIdentities } = schema;

function cookieValue(response: { cookies: Array<{ name: string; value: string }> }, name: string): string | undefined {
  return response.cookies.find((c) => c.name === name)?.value;
}

async function makeTestSigningKey() {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-kid";
  jwk.alg = "RS256";
  jwk.use = "sig";
  const pem = await exportPKCS8(privateKey);
  return { pem, jwk };
}

describe("auth-core.routes (AUTH-BE-14)", () => {
  const config = { ...loadEnv(), AUTH_REFRESH_TOKEN_PEPPER: "test-pepper-do-not-use-in-prod" };
  const { db, sql } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
  const createdUserEmails: string[] = [];
  let app: FastifyInstance;

  beforeAll(async () => {
    const key = await makeTestSigningKey();
    app = await buildAuthCoreProbeApp(db, {
      AUTH_REFRESH_TOKEN_PEPPER: config.AUTH_REFRESH_TOKEN_PEPPER,
      AUTH_JWT_PRIVATE_KEY: key.pem,
      AUTH_JWT_KID: "test-kid",
      AUTH_JWT_PUBLIC_KEY_SET: JSON.stringify({ keys: [key.jwk] }),
    });
  });

  afterEach(async () => {
    for (const email of createdUserEmails) {
      const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
      if (user) {
        await db.delete(authEvents).where(eq(authEvents.userId, user.id));
        const sessions = await db.select({ id: authSessions.id }).from(authSessions).where(eq(authSessions.userId, user.id));
        for (const s of sessions) {
          await db.delete(schema.authRefreshTokens).where(eq(schema.authRefreshTokens.sessionId, s.id));
        }
        await db.delete(authSessions).where(eq(authSessions.userId, user.id));
        const memberships = await db
          .select({ workspaceId: workspaceMembers.workspaceId })
          .from(workspaceMembers)
          .where(eq(workspaceMembers.userId, user.id));
        await db.delete(userCredentials).where(eq(userCredentials.userId, user.id));
        await db.delete(workspaceMembers).where(eq(workspaceMembers.userId, user.id));
        await db.delete(users).where(eq(users.id, user.id));
        for (const m of memberships) {
          await db.delete(creditBalances).where(eq(creditBalances.workspaceId, m.workspaceId));
          await db.delete(schema.creditTransactions).where(eq(schema.creditTransactions.workspaceId, m.workspaceId));
          await db.delete(workspaces).where(eq(workspaces.id, m.workspaceId));
        }
      }
    }
    createdUserEmails.length = 0;
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  function freshEmail(label: string): string {
    const email = `be14-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
    createdUserEmails.push(email);
    return email;
  }

  describe("flag off", () => {
    it("every route 404s when AUTH_CUSTOM_ENABLED is false", async () => {
      const offApp = await buildAuthCoreProbeApp(db, {
        AUTH_CUSTOM_ENABLED: false,
        AUTH_REFRESH_TOKEN_PEPPER: config.AUTH_REFRESH_TOKEN_PEPPER,
      });
      const routes: Array<{ method: "POST" | "GET"; url: string }> = [
        { method: "POST", url: "/api/v1/auth/signup" },
        { method: "POST", url: "/api/v1/auth/login" },
        { method: "POST", url: "/api/v1/auth/refresh" },
        { method: "POST", url: "/api/v1/auth/logout" },
        { method: "POST", url: "/api/v1/auth/logout-all" },
        { method: "GET", url: "/api/v1/auth/me" },
      ];
      for (const route of routes) {
        const res = await offApp.inject({ method: route.method, url: route.url, payload: {} });
        expect(res.statusCode, route.url).toBe(404);
      }
      await offApp.close();
    });
  });

  describe("signup", () => {
    it("creates a user + credential, with the same workspace/credit provisioning as any other provider", async () => {
      const email = freshEmail("signup");
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/signup",
        payload: { email, password: "correct horse battery staple", fullName: "Test User" },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.data.userId).toBeTruthy();

      const [cred] = await db.select().from(userCredentials).where(eq(userCredentials.userId, body.data.userId)).limit(1);
      expect(cred?.hashAlgo).toBe("argon2id");

      const [membership] = await db
        .select()
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, body.data.userId))
        .limit(1);
      expect(membership?.role).toBe("owner");
      const [balance] = await db
        .select()
        .from(creditBalances)
        .where(eq(creditBalances.workspaceId, membership!.workspaceId))
        .limit(1);
      expect(balance?.balance).toBe(500);
    });

    it("rejects a password that fails policy", async () => {
      const email = freshEmail("weakpw");
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/signup",
        payload: { email, password: "short" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects signup for an email that already has a password credential", async () => {
      const email = freshEmail("dupe");
      await app.inject({
        method: "POST",
        url: "/api/v1/auth/signup",
        payload: { email, password: "correct horse battery staple" },
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/signup",
        payload: { email, password: "another long enough password" },
      });
      expect(res.statusCode).toBe(409);
    });

    it("auto-accepts a pending workspace invite for the signup email, same as any other provider", async () => {
      const email = freshEmail("signup-invite");
      const [inviter] = await db
        .insert(users)
        .values({ email: `be14-inviter-${Date.now()}@example.test`, status: "active" })
        .returning();
      const [inviteWorkspace] = await db
        .insert(workspaces)
        .values({ name: "Invite Test Workspace", slug: `be14-invite-${Date.now()}` })
        .returning();
      await db.insert(schema.workspaceInvites).values({
        workspaceId: inviteWorkspace!.id,
        invitedByUserId: inviter!.id,
        email,
        role: "member",
        token: `be14-test-token-${Date.now()}`,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });

      try {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/auth/signup",
          payload: { email, password: "correct horse battery staple" },
        });
        expect(res.statusCode).toBe(201);
        const userId = res.json().data.userId as string;

        const [membership] = await db
          .select()
          .from(workspaceMembers)
          .where(eq(workspaceMembers.userId, userId))
          .limit(1);
        expect(membership?.workspaceId).toBe(inviteWorkspace!.id);
        expect(membership?.role).toBe("member");

        const [invite] = await db
          .select()
          .from(schema.workspaceInvites)
          .where(eq(schema.workspaceInvites.workspaceId, inviteWorkspace!.id))
          .limit(1);
        expect(invite?.acceptedAt).toBeTruthy();
      } finally {
        await db.delete(schema.workspaceInvites).where(eq(schema.workspaceInvites.workspaceId, inviteWorkspace!.id));
        await db.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, inviteWorkspace!.id));
        await db.delete(creditBalances).where(eq(creditBalances.workspaceId, inviteWorkspace!.id));
        await db.delete(schema.creditTransactions).where(eq(schema.creditTransactions.workspaceId, inviteWorkspace!.id));
        await db.delete(workspaces).where(eq(workspaces.id, inviteWorkspace!.id));
        await db.delete(users).where(eq(users.id, inviter!.id));
      }
    });
  });

  describe("login", () => {
    async function signup(email: string, password: string) {
      const res = await app.inject({ method: "POST", url: "/api/v1/auth/signup", payload: { email, password } });
      return res.json().data.userId as string;
    }

    async function markVerified(userId: string) {
      await db
        .update(authIdentities)
        .set({ emailVerifiedAt: new Date() })
        .where(eq(authIdentities.userId, userId));
    }

    it("refuses password login until the email is verified", async () => {
      const email = freshEmail("login-unverified");
      const password = "correct horse battery staple";
      await signup(email, password);
      const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password } });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe("AUTH_EMAIL_NOT_VERIFIED");
    });

    it("correct credentials return an access token and set refresh+csrf cookies", async () => {
      const email = freshEmail("login-ok");
      const password = "correct horse battery staple";
      await markVerified(await signup(email, password));

      const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.accessToken).toBeTruthy();
      expect(body.data.expiresIn).toBe(600);
      expect(cookieValue(res, "skout_refresh")).toBeTruthy();
      expect(cookieValue(res, "skout_csrf")).toBeTruthy();
    });

    it("wrong password and unknown email return the same shape (anti-enumeration)", async () => {
      const email = freshEmail("login-wrong");
      await signup(email, "correct horse battery staple");

      const wrongPw = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email, password: "totally wrong password here" },
      });
      const unknownEmail = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: `nobody-${Date.now()}@example.test`, password: "totally wrong password here" },
      });

      expect(wrongPw.statusCode).toBe(401);
      expect(unknownEmail.statusCode).toBe(401);
      expect(wrongPw.json().code).toBe("AUTH_INVALID_CREDENTIALS");
      expect(unknownEmail.json().code).toBe("AUTH_INVALID_CREDENTIALS");
      expect(wrongPw.json().error).toBe(unknownEmail.json().error);

      const startedWrong = Date.now();
      await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email, password: "another wrong password" },
      });
      const wrongMs = Date.now() - startedWrong;
      const startedUnknown = Date.now();
      await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: `nobody-timing-${Date.now()}@example.test`, password: "another wrong password" },
      });
      const unknownMs = Date.now() - startedUnknown;
      expect(Math.abs(wrongMs - unknownMs)).toBeLessThan(3500);
    });

    it("locks the account after repeated failures", async () => {
      const email = freshEmail("login-lockout");
      await signup(email, "correct horse battery staple");

      let last;
      for (let i = 0; i < 6; i++) {
        last = await app.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          payload: { email, password: "wrong password attempt" },
        });
      }
      expect(last!.statusCode).toBe(429);
      expect(last!.json().code).toBe("AUTH_RATE_LIMITED");

      // Even the correct password is refused while locked.
      const withCorrect = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email, password: "correct horse battery staple" },
      });
      expect(withCorrect.statusCode).toBe(429);
    });

    it("refuses login for a blocked account with the correct password", async () => {
      const email = freshEmail("login-blocked");
      const password = "correct horse battery staple";
      const userId = await signup(email, password);
      await db.update(users).set({ isBlocked: true }).where(eq(users.id, userId));

      const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password } });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe("AUTH_ACCOUNT_BLOCKED");
    });
  });

  describe("refresh / logout / logout-all / me", () => {
    async function loginAndGetCookies(email: string, password: string) {
      const signupRes = await app.inject({ method: "POST", url: "/api/v1/auth/signup", payload: { email, password } });
      await db
        .update(authIdentities)
        .set({ emailVerifiedAt: new Date() })
        .where(eq(authIdentities.userId, signupRes.json().data.userId as string));
      const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password } });
      return {
        accessToken: res.json().data.accessToken as string,
        refresh: cookieValue(res, "skout_refresh")!,
        csrf: cookieValue(res, "skout_csrf")!,
      };
    }

    it("refresh without a matching CSRF header is rejected", async () => {
      const email = freshEmail("refresh-csrf");
      const { refresh } = await loginAndGetCookies(email, "correct horse battery staple");
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        cookies: { skout_refresh: refresh, skout_csrf: "some-value" },
        headers: { "x-csrf-token": "a-different-value" },
      });
      expect(res.statusCode).toBe(403);
    });

    it("refresh with a matching CSRF header rotates the cookie and issues a new access token", async () => {
      const email = freshEmail("refresh-ok");
      const { refresh, csrf } = await loginAndGetCookies(email, "correct horse battery staple");
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        cookies: { skout_refresh: refresh, skout_csrf: csrf },
        headers: { "x-csrf-token": csrf },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.accessToken).toBeTruthy();
      expect(cookieValue(res, "skout_refresh")).not.toBe(refresh);
    });

    it("logout revokes the session so the old refresh cookie stops working", async () => {
      const email = freshEmail("logout");
      const { refresh, csrf } = await loginAndGetCookies(email, "correct horse battery staple");

      const missingCsrf = await app.inject({
        method: "POST",
        url: "/api/v1/auth/logout",
        cookies: { skout_refresh: refresh },
      });
      expect(missingCsrf.statusCode).toBe(403);

      const logoutRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/logout",
        cookies: { skout_refresh: refresh, skout_csrf: csrf },
        headers: { "x-csrf-token": csrf },
      });
      expect(logoutRes.statusCode).toBe(204);

      const refreshAfter = await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        cookies: { skout_refresh: refresh, skout_csrf: csrf },
        headers: { "x-csrf-token": csrf },
      });
      expect(refreshAfter.statusCode).toBe(401);
    });

    it("me returns the authenticated user's profile", async () => {
      const email = freshEmail("me");
      const { accessToken } = await loginAndGetCookies(email, "correct horse battery staple");
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/auth/me",
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.email).toBe(email);
      expect(res.json().data.workspaceId).toBeTruthy();
    });

    it("me without a token is rejected with AUTH_MISSING_TOKEN", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/auth/me" });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe("AUTH_MISSING_TOKEN");
    });

    it("me with a garbage bearer token is rejected with AUTH_TOKEN_INVALID", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/auth/me",
        headers: { authorization: "Bearer not-a-real-jwt" },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe("AUTH_TOKEN_INVALID");
    });

    it("refresh with an unknown cookie value is rejected with AUTH_TOKEN_INVALID", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        cookies: { skout_refresh: "not-a-real-token", skout_csrf: "x" },
        headers: { "x-csrf-token": "x" },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe("AUTH_TOKEN_INVALID");
    });

    it("logout-all revokes every session, so a still-valid access token's session is dead", async () => {
      const email = freshEmail("logout-all");
      const { accessToken, refresh, csrf } = await loginAndGetCookies(email, "correct horse battery staple");

      const logoutAllRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/logout-all",
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(logoutAllRes.statusCode).toBe(204);

      const meAfter = await app.inject({
        method: "GET",
        url: "/api/v1/auth/me",
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(meAfter.statusCode).toBe(401);
      expect(meAfter.json().code).toBe("AUTH_SESSION_REVOKED");

      const refreshAfter = await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        cookies: { skout_refresh: refresh, skout_csrf: csrf },
        headers: { "x-csrf-token": csrf },
      });
      expect(refreshAfter.statusCode).toBe(401);
    });
  });

  afterAll(async () => {
    await app?.close();
    await sql.end();
  });
});
