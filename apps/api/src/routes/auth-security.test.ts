import { generateKeyPair, exportJWK, exportPKCS8, SignJWT } from "jose";
import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, schema } from "@skout/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  AuthErrorCode,
  AuthErrorMessage,
  HttpError,
  sanitizeRedirectPath,
  isSafeRedirectPath,
} from "@skout/auth";
import { loadEnv, type Env } from "../config/env.js";
import { buildAuthCoreProbeApp } from "../test/auth-core-probe-app.js";
import {
  signAccessToken,
  verifyAccessToken,
  ACCESS_TOKEN_TTL_SECONDS,
} from "../services/token.service.js";
import {
  createSession,
  rotateRefreshToken,
  revokeAllSessionsForUser,
  isSessionRevoked,
} from "../services/session.service.js";
import {
  hashPassword,
  verifyUnknownUser,
} from "../services/credential.service.js";
import {
  markPasswordEmailVerified,
} from "../services/auth-recovery.service.js";
import {
  ACCOUNT_FAILURE_THRESHOLD,
  ACCOUNT_LOCK_SECONDS,
  recordIpFailureAndCheckLocked,
  isIpLocked,
  clearIpFailures,
} from "../services/auth-lockout.service.js";
import { getRedis, closeRedis } from "../lib/redis.js";

const { users, userCredentials, authSessions, authRefreshTokens, authEvents } = schema;

async function makeTestSigningKey(kid: string) {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = kid;
  jwk.alg = "RS256";
  jwk.use = "sig";
  const pem = await exportPKCS8(privateKey);
  return { pem, jwk };
}

function cookieValue(response: { cookies: Array<{ name: string; value: string }> }, name: string): string | undefined {
  return response.cookies.find((c) => c.name === name)?.value;
}

describe("AUTH-BE-18 — Auth Security Test Suite & Threat Controls", () => {
  const baseConfig = { ...loadEnv(), AUTH_REFRESH_TOKEN_PEPPER: "test-security-pepper-secret-32-bytes" };
  const { db, sql } = createDb(baseConfig.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
  const createdUserIds: string[] = [];
  let app: FastifyInstance;
  let testKey: { pem: string; jwk: ReturnType<typeof JSON.parse> };
  let testConfig: Env;

  beforeAll(async () => {
    testKey = await makeTestSigningKey("security-kid-primary");
    testConfig = {
      ...baseConfig,
      SMTP_HOST: "",
      AUTH_JWT_PRIVATE_KEY: testKey.pem,
      AUTH_JWT_KID: "security-kid-primary",
      AUTH_JWT_PUBLIC_KEY_SET: JSON.stringify({ keys: [testKey.jwk] }),
      AUTH_JWT_ISSUER: "https://auth.skout.test",
      AUTH_JWT_AUDIENCE: "skout-api-test",
    } as Env;

    app = await buildAuthCoreProbeApp(db, {
      SMTP_HOST: "",
      AUTH_REFRESH_TOKEN_PEPPER: testConfig.AUTH_REFRESH_TOKEN_PEPPER,
      AUTH_JWT_PRIVATE_KEY: testConfig.AUTH_JWT_PRIVATE_KEY,
      AUTH_JWT_KID: testConfig.AUTH_JWT_KID,
      AUTH_JWT_PUBLIC_KEY_SET: testConfig.AUTH_JWT_PUBLIC_KEY_SET,
      AUTH_JWT_ISSUER: testConfig.AUTH_JWT_ISSUER,
      AUTH_JWT_AUDIENCE: testConfig.AUTH_JWT_AUDIENCE,
    });
  });

  afterEach(async () => {
    for (const userId of createdUserIds) {
      await db.delete(authEvents).where(eq(authEvents.userId, userId));
      const sessions = await db.select({ id: authSessions.id }).from(authSessions).where(eq(authSessions.userId, userId));
      for (const s of sessions) {
        await db.delete(authRefreshTokens).where(eq(authRefreshTokens.sessionId, s.id));
      }
      await db.delete(authSessions).where(eq(authSessions.userId, userId));
      await db.delete(schema.authIdentities).where(eq(schema.authIdentities.userId, userId));
      await db.delete(userCredentials).where(eq(userCredentials.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
    createdUserIds.length = 0;
  });

  afterAll(async () => {
    await app?.close();
    await closeRedis();
    await sql.end();
  });

  // =========================================================================
  // 1. Token Forgery Matrix
  // =========================================================================
  describe("1. Token Forgery Matrix", () => {
    it("rejects token with alg: none", async () => {
      const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(
        JSON.stringify({
          sub: "user-forged-1",
          sid: "session-forged-1",
          iss: testConfig.AUTH_JWT_ISSUER,
          aud: testConfig.AUTH_JWT_AUDIENCE,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 600,
        })
      ).toString("base64url");
      const forged = `${header}.${payload}.`;
      await expect(verifyAccessToken(forged, testConfig)).rejects.toThrow(HttpError);
    });

    it("rejects algorithm confusion attack (HMAC HS256 using public RSA key as secret)", async () => {
      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT", kid: "security-kid-primary" })).toString("base64url");
      const payload = Buffer.from(
        JSON.stringify({
          sub: "user-forged-2",
          sid: "session-forged-2",
          iss: testConfig.AUTH_JWT_ISSUER,
          aud: testConfig.AUTH_JWT_AUDIENCE,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 600,
        })
      ).toString("base64url");
      const unsigned = `${header}.${payload}`;
      const hmacSig = createHmac("sha256", JSON.stringify(testKey.jwk)).update(unsigned).digest("base64url");
      const forged = `${unsigned}.${hmacSig}`;
      await expect(verifyAccessToken(forged, testConfig)).rejects.toThrow(HttpError);
    });

    it("rejects token signed with an unknown or rogue key (not in JWKS)", async () => {
      const rogueKey = await makeTestSigningKey("kid-rogue");
      const rogueConfig = {
        ...testConfig,
        AUTH_JWT_PRIVATE_KEY: rogueKey.pem,
        AUTH_JWT_KID: "kid-rogue",
      };
      const token = await signAccessToken({ sub: "user-rogue", sid: "session-rogue" }, rogueConfig);
      // Attempt verification against our genuine JWKS
      await expect(verifyAccessToken(token, testConfig)).rejects.toThrow(HttpError);
    });

    it("rejects token with wrong kid header even if payload is valid", async () => {
      const token = await signAccessToken({ sub: "user-1", sid: "session-1" }, testConfig);
      const [, payloadB64, sigB64] = token.split(".");
      const forgedHeader = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "non-existent-kid" })).toString("base64url");
      const forged = `${forgedHeader}.${payloadB64}.${sigB64}`;
      await expect(verifyAccessToken(forged, testConfig)).rejects.toThrow(HttpError);
    });

    it("rejects token with wrong audience", async () => {
      const wrongAudConfig = { ...testConfig, AUTH_JWT_AUDIENCE: "different-aud" };
      const token = await signAccessToken({ sub: "user-1", sid: "session-1" }, wrongAudConfig);
      await expect(verifyAccessToken(token, testConfig)).rejects.toThrow(HttpError);
    });

    it("rejects token with wrong issuer", async () => {
      const wrongIssConfig = { ...testConfig, AUTH_JWT_ISSUER: "https://attacker-issuer.com" };
      const token = await signAccessToken({ sub: "user-1", sid: "session-1" }, wrongIssConfig);
      await expect(verifyAccessToken(token, testConfig)).rejects.toThrow(HttpError);
    });

    it("rejects expired token", async () => {
      const { importPKCS8 } = await import("jose");
      const privateKey = await importPKCS8(testKey.pem, "RS256");
      const expiredToken = await new SignJWT({ sid: "session-1" })
        .setProtectedHeader({ alg: "RS256", kid: "security-kid-primary" })
        .setIssuer(testConfig.AUTH_JWT_ISSUER)
        .setAudience(testConfig.AUTH_JWT_AUDIENCE)
        .setSubject("user-1")
        .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
        .sign(privateKey);

      await expect(verifyAccessToken(expiredToken, testConfig)).rejects.toThrow(HttpError);
    });

    it("rejects not-yet-valid token (future nbf)", async () => {
      const { importPKCS8 } = await import("jose");
      const privateKey = await importPKCS8(testKey.pem, "RS256");
      const futureToken = await new SignJWT({ sid: "session-1" })
        .setProtectedHeader({ alg: "RS256", kid: "security-kid-primary" })
        .setIssuer(testConfig.AUTH_JWT_ISSUER)
        .setAudience(testConfig.AUTH_JWT_AUDIENCE)
        .setSubject("user-1")
        .setIssuedAt(Math.floor(Date.now() / 1000))
        .setNotBefore(Math.floor(Date.now() / 1000) + 3600)
        .setExpirationTime(Math.floor(Date.now() / 1000) + 7200)
        .sign(privateKey);

      await expect(verifyAccessToken(futureToken, testConfig)).rejects.toThrow(HttpError);
    });

    it("rejects token with tampered payload content", async () => {
      const token = await signAccessToken({ sub: "normal-user", sid: "session-1" }, testConfig);
      const [headerB64, , sigB64] = token.split(".");
      const tamperedPayload = Buffer.from(
        JSON.stringify({
          sub: "admin-user-elevated",
          sid: "session-1",
          iss: testConfig.AUTH_JWT_ISSUER,
          aud: testConfig.AUTH_JWT_AUDIENCE,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS,
        })
      ).toString("base64url");
      const forged = `${headerB64}.${tamperedPayload}.${sigB64}`;
      await expect(verifyAccessToken(forged, testConfig)).rejects.toThrow(HttpError);
    });

    it("rejects truncated token with missing signature", async () => {
      const token = await signAccessToken({ sub: "user-1", sid: "session-1" }, testConfig);
      const [headerB64, payloadB64] = token.split(".");
      await expect(verifyAccessToken(`${headerB64}.${payloadB64}`, testConfig)).rejects.toThrow(HttpError);
    });
  });

  // =========================================================================
  // 2. Refresh Token Reuse Detection & Revocation (Theft Signal)
  // =========================================================================
  describe("2. Refresh Token Reuse Detection & Revocation", () => {
    it("detects reuse of already-used refresh token and immediately revokes entire session chain", async () => {
      const email = `reuse-test-${Date.now()}@example.com`;
      const [user] = await db.insert(users).values({ email, fullName: "Reuse Test", status: "active" }).returning();
      createdUserIds.push(user.id);

      // Create session and first refresh token T1
      const created = await createSession(db, testConfig, user.id, { ip: "127.0.0.1", userAgent: "test-agent" });
      const tokenT1 = created.refreshToken;

      // Legitimate user rotates T1 -> receives T2
      const rotation1 = await rotateRefreshToken(db, testConfig, tokenT1, { ip: "127.0.0.1", userAgent: "test-agent" });
      expect(rotation1).not.toBeNull();
      const tokenT2 = rotation1!.refreshToken;

      // Age the used token beyond REUSE_GRACE_MS (5s) so it's treated as a theft signal
      await db
        .update(authRefreshTokens)
        .set({ usedAt: new Date(Date.now() - 10_000) })
        .where(eq(authRefreshTokens.sessionId, created.sessionId));

      // Attacker replays T1 (theft signal!)
      await expect(
        rotateRefreshToken(db, testConfig, tokenT1, { ip: "192.168.1.100", userAgent: "attacker-agent" })
      ).rejects.toThrow(HttpError);

      // Verify in DB that the entire session is revoked with reason "reuse_detected"
      const [sessionRow] = await db
        .select()
        .from(authSessions)
        .where(eq(authSessions.id, created.sessionId))
        .limit(1);
      expect(sessionRow.revokedAt).not.toBeNull();
      expect(sessionRow.revokedReason).toBe("refresh_reuse_detected");

      // Now legitimate user tries to use T2 -> MUST fail because entire session was revoked
      await expect(
        rotateRefreshToken(db, testConfig, tokenT2, { ip: "127.0.0.1", userAgent: "test-agent" })
      ).rejects.toThrow(HttpError);

      // Verify audit event "refresh_reuse_detected" was recorded
      const [event] = await db
        .select()
        .from(authEvents)
        .where(eq(authEvents.type, "refresh_reuse_detected"))
        .limit(1);
      expect(event).toBeDefined();
      expect(event.userId).toBe(user.id);
    });
  });

  // =========================================================================
  // 3. Brute-Force & Lockout Defense
  // =========================================================================
  describe("3. Brute-Force & Lockout Defense", () => {
    it("locks the account after repeated password failures and refuses correct password while locked", async () => {
      const email = `lockout-test-${Date.now()}@example.com`;
      const password = "CorrectPassword123!";
      const [user] = await db.insert(users).values({ email, fullName: "Lockout Test", status: "active" }).returning();
      createdUserIds.push(user.id);

      const hashRes = await hashPassword(password);
      await db.insert(userCredentials).values({
        userId: user.id,
        passwordHash: hashRes.hash,
        hashAlgo: hashRes.algo,
        hashParams: hashRes.params,
        failedAttempts: 0,
      });

      // Submit incorrect password repeatedly until reaching threshold
      for (let i = 0; i < ACCOUNT_FAILURE_THRESHOLD; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          payload: { email, password: "WrongPassword!" },
        });
        expect(res.statusCode).toBe(401);
      }

      // Verify account is locked in DB
      const [credRow] = await db
        .select()
        .from(userCredentials)
        .where(eq(userCredentials.userId, user.id))
        .limit(1);
      expect(credRow.failedAttempts).toBe(ACCOUNT_FAILURE_THRESHOLD);
      expect(credRow.lockedUntil).not.toBeNull();
      expect(credRow.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

      // Subsequent attempt even with the CORRECT password returns 429 AUTH_RATE_LIMITED
      const lockedRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email, password },
      });
      expect(lockedRes.statusCode).toBe(429);
      expect(lockedRes.json()).toMatchObject({
        code: AuthErrorCode.AUTH_RATE_LIMITED,
      });
    });

    it("locks IP after exceeding failure threshold and fails fast (or degrades gracefully without Redis)", async () => {
      const redis = getRedis(testConfig);
      let redisReachable = false;
      if (redis) {
        try {
          if (redis.status === "wait") await redis.connect();
          await redis.ping();
          redisReachable = true;
        } catch {
          redisReachable = false;
        }
      }

      const testIp = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
      if (!redisReachable) {
        // Without Redis (e.g. CI standard runner), verify defense degrades gracefully (fails open)
        const notLocked = await recordIpFailureAndCheckLocked(testConfig, testIp);
        expect(notLocked).toBe(false);
        expect(await isIpLocked(testConfig, testIp)).toBe(false);
        return;
      }

      await clearIpFailures(testConfig, testIp);

      // Simulate failures from this IP
      for (let i = 0; i < 20; i++) {
        await recordIpFailureAndCheckLocked(testConfig, testIp);
      }
      const isLocked = await isIpLocked(testConfig, testIp);
      expect(isLocked).toBe(false);

      // The 21st failure crosses threshold
      const nowLocked = await recordIpFailureAndCheckLocked(testConfig, testIp);
      expect(nowLocked).toBe(true);
      expect(await isIpLocked(testConfig, testIp)).toBe(true);

      // Clean up IP key
      await clearIpFailures(testConfig, testIp);
    });
  });

  // =========================================================================
  // 4. Account Enumeration Defense
  // =========================================================================
  describe("4. Account Enumeration Defense", () => {
    it("returns identical 401 status, error code, and error body for wrong password vs non-existent email", async () => {
      const email = `enum-test-${Date.now()}@example.com`;
      const [user] = await db.insert(users).values({ email, fullName: "Enum Test", status: "active" }).returning();
      createdUserIds.push(user.id);

      const hashRes = await hashPassword("RealPassword123!");
      await db.insert(userCredentials).values({
        userId: user.id,
        passwordHash: hashRes.hash,
        hashAlgo: hashRes.algo,
        hashParams: hashRes.params,
        failedAttempts: 0,
      });

      // 1. Wrong password on existing account
      const resExisting = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email, password: "IncorrectPassword!" },
      });

      // 2. Non-existent account
      const resNonExistent = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: `non-existent-${Date.now()}@example.com`, password: "IncorrectPassword!" },
      });

      expect(resExisting.statusCode).toBe(401);
      expect(resNonExistent.statusCode).toBe(401);

      // Exact same response contract
      expect(resExisting.json()).toEqual(resNonExistent.json());
      expect(resExisting.json()).toMatchObject({
        code: AuthErrorCode.AUTH_INVALID_CREDENTIALS,
        error: "Invalid email or password.",
      });
    });

    it("forgot-password returns identical success envelope for existing and non-existent email", async () => {
      const email = `forgot-enum-${Date.now()}@example.com`;
      const [user] = await db.insert(users).values({ email, fullName: "Forgot Enum", status: "active" }).returning();
      createdUserIds.push(user.id);

      const resRegistered = await app.inject({
        method: "POST",
        url: "/api/v1/auth/password/forgot",
        payload: { email },
      });

      const resUnregistered = await app.inject({
        method: "POST",
        url: "/api/v1/auth/password/forgot",
        payload: { email: `not-real-${Date.now()}@example.com` },
      });

      expect(resRegistered.statusCode).toBe(200);
      expect(resUnregistered.statusCode).toBe(200);
      expect(resRegistered.json().ok).toBe(true);
      expect(resUnregistered.json().ok).toBe(true);
    });

    it("verifyUnknownUser runs constant-time computation without error", async () => {
      const res = await verifyUnknownUser("ArbitraryPassword123!");
      expect(res).toEqual({ valid: false, needsRehash: false });
    });
  });

  // =========================================================================
  // 5. CSRF Protection on Cookie Endpoints
  // =========================================================================
  describe("5. CSRF Protection on Cookie Endpoints", () => {
    it("rejects refresh without matching x-csrf-token header", async () => {
      const email = `csrf-test-${Date.now()}@example.com`;
      const [user] = await db.insert(users).values({ email, fullName: "CSRF Test", status: "active" }).returning();
      createdUserIds.push(user.id);

      const session = await createSession(db, testConfig, user.id);

      // 1. Missing header entirely
      const resNoHeader = await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        cookies: {
          skout_refresh: session.refreshToken,
          skout_csrf: "valid-csrf-token-12345",
        },
      });
      expect(resNoHeader.statusCode).toBe(403);

      // 2. Mismatched header
      const resMismatch = await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        cookies: {
          skout_refresh: session.refreshToken,
          skout_csrf: "valid-csrf-token-12345",
        },
        headers: {
          "x-csrf-token": "attacker-forged-csrf-token",
        },
      });
      expect(resMismatch.statusCode).toBe(403);

      // 3. Matching header succeeds
      const resMatch = await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        cookies: {
          skout_refresh: session.refreshToken,
          skout_csrf: "valid-csrf-token-12345",
        },
        headers: {
          "x-csrf-token": "valid-csrf-token-12345",
        },
      });
      expect(resMatch.statusCode).toBe(200);
      expect(resMatch.json().data.accessToken).toBeTypeOf("string");
    });

    it("rejects logout without matching x-csrf-token header", async () => {
      const email = `csrf-logout-${Date.now()}@example.com`;
      const [user] = await db.insert(users).values({ email, fullName: "CSRF Logout", status: "active" }).returning();
      createdUserIds.push(user.id);

      const session = await createSession(db, testConfig, user.id);

      const resNoHeader = await app.inject({
        method: "POST",
        url: "/api/v1/auth/logout",
        cookies: {
          skout_refresh: session.refreshToken,
          skout_csrf: "csrf-val",
        },
      });
      expect(resNoHeader.statusCode).toBe(403);

      const resSuccess = await app.inject({
        method: "POST",
        url: "/api/v1/auth/logout",
        cookies: {
          skout_refresh: session.refreshToken,
          skout_csrf: "csrf-val",
        },
        headers: {
          "x-csrf-token": "csrf-val",
        },
      });
      expect(resSuccess.statusCode).toBe(204);
    });
  });

  // =========================================================================
  // 6. Open-Redirect Defense on Redirect/Next Parameters
  // =========================================================================
  describe("6. Open-Redirect Defense on Redirect/Next Parameters", () => {
    it("sanitizes absolute external URLs to fallback", () => {
      expect(sanitizeRedirectPath("https://evil.example", "/dashboard")).toBe("/dashboard");
      expect(sanitizeRedirectPath("http://evil.example/login", "/dashboard")).toBe("/dashboard");
      expect(sanitizeRedirectPath("https://attacker.com/steal?token=1", "/dashboard")).toBe("/dashboard");
    });

    it("sanitizes protocol-relative URLs to fallback", () => {
      expect(sanitizeRedirectPath("//evil.example", "/dashboard")).toBe("/dashboard");
      expect(sanitizeRedirectPath("///evil.example", "/dashboard")).toBe("/dashboard");
      expect(sanitizeRedirectPath("//evil.example/path", "/dashboard")).toBe("/dashboard");
    });

    it("sanitizes backslash bypass attempts to fallback", () => {
      expect(sanitizeRedirectPath("\\evil.example", "/dashboard")).toBe("/dashboard");
      expect(sanitizeRedirectPath("/\\evil.example", "/dashboard")).toBe("/dashboard");
      expect(sanitizeRedirectPath("//\\evil.example", "/dashboard")).toBe("/dashboard");
    });

    it("sanitizes pseudo-protocols to fallback", () => {
      expect(sanitizeRedirectPath("javascript:alert(1)", "/dashboard")).toBe("/dashboard");
      expect(sanitizeRedirectPath("data:text/html,<script>alert(1)</script>", "/dashboard")).toBe("/dashboard");
      expect(sanitizeRedirectPath("vbscript:msgbox(1)", "/dashboard")).toBe("/dashboard");
    });

    it("allows valid relative paths and same-origin paths", () => {
      expect(sanitizeRedirectPath("/dashboard", "/fallback")).toBe("/dashboard");
      expect(sanitizeRedirectPath("/settings?tab=security", "/fallback")).toBe("/settings?tab=security");
      expect(sanitizeRedirectPath("/onboarding/step-2#finish", "/fallback")).toBe("/onboarding/step-2#finish");

      // Allowed absolute origin
      expect(
        sanitizeRedirectPath("https://app.skoutai.io/dashboard", "/fallback", ["https://app.skoutai.io"])
      ).toBe("/dashboard");
    });

    it("isSafeRedirectPath correctly classifies redirect targets", () => {
      expect(isSafeRedirectPath("/dashboard")).toBe(true);
      expect(isSafeRedirectPath("https://evil.example")).toBe(false);
      expect(isSafeRedirectPath("//evil.example")).toBe(false);
      expect(isSafeRedirectPath("\\evil.example")).toBe(false);
      expect(isSafeRedirectPath("javascript:alert(1)")).toBe(false);
    });
  });

  // =========================================================================
  // 7. Session Fixation Defense
  // =========================================================================
  describe("7. Session Fixation Defense", () => {
    it("generates a fresh session ID on login rather than adopting pre-existing state", async () => {
      const email = `fixation-${Date.now()}@example.com`;
      const password = "FixationTestPassword123!";

      const [user] = await db.insert(users).values({ email, fullName: "Fixation Test", status: "active" }).returning();
      createdUserIds.push(user.id);

      const hashRes = await hashPassword(password);
      await db.insert(userCredentials).values({
        userId: user.id,
        passwordHash: hashRes.hash,
        hashAlgo: hashRes.algo,
        hashParams: hashRes.params,
        failedAttempts: 0,
      });

      await markPasswordEmailVerified(db, user.id, email);

      // Login 1
      const res1 = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email, password },
      });
      expect(res1.statusCode).toBe(200);
      const refreshCookie1 = cookieValue(res1, "skout_refresh");

      // Login 2
      const res2 = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email, password },
      });
      expect(res2.statusCode).toBe(200);
      const refreshCookie2 = cookieValue(res2, "skout_refresh");

      // Each login establishes a distinct, newly-minted session and refresh token
      expect(refreshCookie1).toBeDefined();
      expect(refreshCookie2).toBeDefined();
      expect(refreshCookie1).not.toBe(refreshCookie2);
    });

    it("password change or reset revokes all existing sessions", async () => {
      const email = `reset-revoke-${Date.now()}@example.com`;
      const [user] = await db.insert(users).values({ email, fullName: "Reset Revoke", status: "active" }).returning();
      createdUserIds.push(user.id);

      // Create two sessions on different devices
      const s1 = await createSession(db, testConfig, user.id);
      const s2 = await createSession(db, testConfig, user.id);

      expect(await isSessionRevoked(db, testConfig, s1.sessionId)).toBe(false);
      expect(await isSessionRevoked(db, testConfig, s2.sessionId)).toBe(false);

      // Reset password / revoke all sessions
      await revokeAllSessionsForUser(db, testConfig, user.id, "password_changed");

      // Both sessions are immediately dead
      expect(await isSessionRevoked(db, testConfig, s1.sessionId)).toBe(true);
      expect(await isSessionRevoked(db, testConfig, s2.sessionId)).toBe(true);
    });
  });

  // =========================================================================
  // 8. Blocked-User Immediacy
  // =========================================================================
  describe("8. Blocked-User Immediacy", () => {
    it("refuses login immediately for blocked accounts", async () => {
      const email = `blocked-login-${Date.now()}@example.com`;
      const password = "BlockedPassword123!";
      const [user] = await db.insert(users).values({ email, fullName: "Blocked User", status: "active", isBlocked: true }).returning();
      createdUserIds.push(user.id);

      const hashRes = await hashPassword(password);
      await db.insert(userCredentials).values({
        userId: user.id,
        passwordHash: hashRes.hash,
        hashAlgo: hashRes.algo,
        hashParams: hashRes.params,
        failedAttempts: 0,
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email, password },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({
        code: AuthErrorCode.AUTH_ACCOUNT_BLOCKED,
      });
    });

    it("refuses token refresh immediately when user is blocked", async () => {
      const email = `blocked-refresh-${Date.now()}@example.com`;
      const [user] = await db.insert(users).values({ email, fullName: "Blocked Refresh", status: "active", isBlocked: false }).returning();
      createdUserIds.push(user.id);

      const session = await createSession(db, testConfig, user.id);

      // Block user
      await db.update(users).set({ isBlocked: true }).where(eq(users.id, user.id));

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        cookies: {
          skout_refresh: session.refreshToken,
          skout_csrf: "csrf-token-123",
        },
        headers: {
          "x-csrf-token": "csrf-token-123",
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({
        code: AuthErrorCode.AUTH_ACCOUNT_BLOCKED,
      });
    });
  });
});
