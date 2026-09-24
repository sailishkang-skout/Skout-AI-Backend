import { afterEach, describe, expect, it, vi } from "vitest";
import * as skoutAuth from "@skout/auth";
import {
  AuthErrorCode,
  AuthErrorMessage,
  assertStepUp,
  buildTestAuthEnv,
  buildTestAuthToken,
  TEST_CLERK_ISSUER,
} from "@skout/auth";
import { createDb, schema } from "@skout/db";
import { eq } from "drizzle-orm";
import { loadEnv } from "../config/env.js";
import { buildStepUpProbeApp } from "../test/step-up-probe-app.js";
import { hashPassword } from "../services/credential.service.js";
import { ACCOUNT_FAILURE_THRESHOLD } from "../services/auth-lockout.service.js";

const { users, userCredentials, authEvents } = schema;

const SESSION_USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const clerkOverrides = buildTestAuthEnv(TEST_CLERK_ISSUER, {
  STEP_UP_SIGNING_SECRET: "step-up-test-signing-secret",
});

describe("POST /api/v1/auth/step-up", () => {
  const config = { ...loadEnv(), ...clerkOverrides };
  const { db } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
  const createdUserIds: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const userId of createdUserIds) {
      await db.delete(authEvents).where(eq(authEvents.userId, userId));
      await db.delete(userCredentials).where(eq(userCredentials.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
    createdUserIds.length = 0;
  });

  describe("Clerk re-authentication path (legacy & dual-verify)", () => {
    it("returns 401 when the request is not authenticated", async () => {
      const app = await buildStepUpProbeApp(clerkOverrides, db);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/step-up",
        payload: { clerkToken: buildTestAuthToken() },
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it("returns 403 when re-auth resolves to a different internal user", async () => {
      const app = await buildStepUpProbeApp(clerkOverrides, db);
      const sessionJwt = buildTestAuthToken(TEST_CLERK_ISSUER, "session-subject");
      const stepUpJwt = buildTestAuthToken(TEST_CLERK_ISSUER, "step-up-subject");

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
      const app = await buildStepUpProbeApp(clerkOverrides, db);
      const sessionJwt = buildTestAuthToken(TEST_CLERK_ISSUER, "session-subject");
      const stepUpJwt = buildTestAuthToken(TEST_CLERK_ISSUER, "step-up-subject");

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

  describe("Native password re-authentication path (AUTH-BE-27)", () => {
    it("returns 400 when neither clerkToken nor password is provided", async () => {
      const app = await buildStepUpProbeApp(clerkOverrides, db);
      const sessionJwt = buildTestAuthToken(TEST_CLERK_ISSUER, "session-subject");

      vi.spyOn(skoutAuth, "resolveAuth").mockResolvedValue({
        provider: "clerk",
        subject: "clerk_user",
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
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("Invalid step-up payload");
      await app.close();
    });

    it("issues a reauth token when correct password is provided for own-auth user", async () => {
      const app = await buildStepUpProbeApp(clerkOverrides, db);
      const email = `stepup-success-${Date.now()}@example.com`;
      const plainPassword = "SecurePassword123!";

      const [user] = await db
        .insert(users)
        .values({
          email,
          fullName: "Step Up User",
          status: "active",
          isBlocked: false,
        })
        .returning();
      createdUserIds.push(user.id);

      const hashResult = await hashPassword(plainPassword);
      await db.insert(userCredentials).values({
        userId: user.id,
        passwordHash: hashResult.hash,
        hashAlgo: hashResult.algo,
        hashParams: hashResult.params,
        failedAttempts: 0,
      });

      const sessionJwt = buildTestAuthToken(TEST_CLERK_ISSUER, "session-stepup");
      vi.spyOn(skoutAuth, "resolveAuth").mockResolvedValue({
        provider: "clerk",
        subject: "stepup_user",
        emailVerified: true,
      });
      vi.spyOn(skoutAuth, "resolveOrProvisionUser").mockResolvedValue({
        userId: user.id,
        userEmail: email,
        workspaceId: "11111111-1111-4111-8111-111111111111",
        role: "member",
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/step-up",
        headers: { authorization: `Bearer ${sessionJwt}` },
        payload: { password: plainPassword },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json().data;
      expect(data.reauthToken).toBeTypeOf("string");
      expect(data.expiresInMinutes).toBe(15);

      // Verify the issued token using assertStepUp
      expect(() => {
        assertStepUp(
          { "x-reauth-token": data.reauthToken as string },
          clerkOverrides.STEP_UP_SIGNING_SECRET as string,
          user.id
        );
      }).not.toThrow();

      // Ensure failed attempts reset to 0
      const [cred] = await db
        .select()
        .from(userCredentials)
        .where(eq(userCredentials.userId, user.id))
        .limit(1);
      expect(cred.failedAttempts).toBe(0);

      await app.close();
    });

    it("returns 401 and increments failed attempts on wrong password", async () => {
      const app = await buildStepUpProbeApp(clerkOverrides, db);
      const email = `stepup-fail-${Date.now()}@example.com`;
      const plainPassword = "SecurePassword123!";

      const [user] = await db
        .insert(users)
        .values({
          email,
          fullName: "Step Up User",
          status: "active",
          isBlocked: false,
        })
        .returning();
      createdUserIds.push(user.id);

      const hashResult = await hashPassword(plainPassword);
      await db.insert(userCredentials).values({
        userId: user.id,
        passwordHash: hashResult.hash,
        hashAlgo: hashResult.algo,
        hashParams: hashResult.params,
        failedAttempts: 0,
      });

      const sessionJwt = buildTestAuthToken(TEST_CLERK_ISSUER, "session-stepup-fail");
      vi.spyOn(skoutAuth, "resolveAuth").mockResolvedValue({
        provider: "clerk",
        subject: "stepup_fail_user",
        emailVerified: true,
      });
      vi.spyOn(skoutAuth, "resolveOrProvisionUser").mockResolvedValue({
        userId: user.id,
        userEmail: email,
        workspaceId: "11111111-1111-4111-8111-111111111111",
        role: "member",
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/step-up",
        headers: { authorization: `Bearer ${sessionJwt}` },
        payload: { password: "WrongPassword123!" },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({
        code: AuthErrorCode.AUTH_INVALID_CREDENTIALS,
      });

      const [cred] = await db
        .select()
        .from(userCredentials)
        .where(eq(userCredentials.userId, user.id))
        .limit(1);
      expect(cred.failedAttempts).toBe(1);

      await app.close();
    });

    it("locks the account after repeated password failures", async () => {
      const app = await buildStepUpProbeApp(clerkOverrides, db);
      const email = `stepup-lockout-${Date.now()}@example.com`;
      const plainPassword = "SecurePassword123!";

      const [user] = await db
        .insert(users)
        .values({
          email,
          fullName: "Step Up Lockout User",
          status: "active",
          isBlocked: false,
        })
        .returning();
      createdUserIds.push(user.id);

      const hashResult = await hashPassword(plainPassword);
      // Pre-set failed attempts to ACCOUNT_FAILURE_THRESHOLD - 1 so the next attempt triggers lockout
      await db.insert(userCredentials).values({
        userId: user.id,
        passwordHash: hashResult.hash,
        hashAlgo: hashResult.algo,
        hashParams: hashResult.params,
        failedAttempts: ACCOUNT_FAILURE_THRESHOLD - 1,
      });

      const sessionJwt = buildTestAuthToken(TEST_CLERK_ISSUER, "session-stepup-lockout");
      vi.spyOn(skoutAuth, "resolveAuth").mockResolvedValue({
        provider: "clerk",
        subject: "stepup_lockout_user",
        emailVerified: true,
      });
      vi.spyOn(skoutAuth, "resolveOrProvisionUser").mockResolvedValue({
        userId: user.id,
        userEmail: email,
        workspaceId: "11111111-1111-4111-8111-111111111111",
        role: "member",
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/step-up",
        headers: { authorization: `Bearer ${sessionJwt}` },
        payload: { password: "WrongPasswordAgain!" },
      });

      // The attempt that hits or exceeds threshold sets lockedUntil and fails
      expect(res.statusCode).toBe(401);

      const [cred] = await db
        .select()
        .from(userCredentials)
        .where(eq(userCredentials.userId, user.id))
        .limit(1);
      expect(cred.failedAttempts).toBe(ACCOUNT_FAILURE_THRESHOLD);
      expect(cred.lockedUntil).not.toBeNull();
      expect(cred.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

      // Subsequent attempt while locked returns 429 AUTH_RATE_LIMITED
      const lockedRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/step-up",
        headers: { authorization: `Bearer ${sessionJwt}` },
        payload: { password: plainPassword }, // even with correct password
      });
      expect(lockedRes.statusCode).toBe(429);
      expect(lockedRes.json()).toMatchObject({
        code: AuthErrorCode.AUTH_RATE_LIMITED,
      });

      await app.close();
    });

    it("returns 403 AUTH_REAUTH_USER_MISMATCH when email provided does not match session user", async () => {
      const app = await buildStepUpProbeApp(clerkOverrides, db);
      const email = `stepup-mismatch-${Date.now()}@example.com`;
      const otherEmail = `stepup-other-${Date.now()}@example.com`;
      const plainPassword = "SecurePassword123!";

      const [user] = await db
        .insert(users)
        .values({
          email,
          fullName: "Step Up User",
          status: "active",
          isBlocked: false,
        })
        .returning();
      createdUserIds.push(user.id);

      const hashResult = await hashPassword(plainPassword);
      await db.insert(userCredentials).values({
        userId: user.id,
        passwordHash: hashResult.hash,
        hashAlgo: hashResult.algo,
        hashParams: hashResult.params,
        failedAttempts: 0,
      });

      const sessionJwt = buildTestAuthToken(TEST_CLERK_ISSUER, "session-stepup-mismatch");
      vi.spyOn(skoutAuth, "resolveAuth").mockResolvedValue({
        provider: "clerk",
        subject: "stepup_user",
        emailVerified: true,
      });
      vi.spyOn(skoutAuth, "resolveOrProvisionUser").mockResolvedValue({
        userId: user.id,
        userEmail: email,
        workspaceId: "11111111-1111-4111-8111-111111111111",
        role: "member",
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/step-up",
        headers: { authorization: `Bearer ${sessionJwt}` },
        payload: { email: otherEmail, password: plainPassword },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({
        code: AuthErrorCode.AUTH_REAUTH_USER_MISMATCH,
        error: AuthErrorMessage.REAUTH_USER_MISMATCH,
      });

      await app.close();
    });

    it("returns 403 AUTH_ACCOUNT_BLOCKED when account is blocked or inactive", async () => {
      const app = await buildStepUpProbeApp(clerkOverrides, db);
      const email = `stepup-blocked-${Date.now()}@example.com`;
      const plainPassword = "SecurePassword123!";

      const [user] = await db
        .insert(users)
        .values({
          email,
          fullName: "Step Up Blocked User",
          status: "active",
          isBlocked: true,
        })
        .returning();
      createdUserIds.push(user.id);

      const hashResult = await hashPassword(plainPassword);
      await db.insert(userCredentials).values({
        userId: user.id,
        passwordHash: hashResult.hash,
        hashAlgo: hashResult.algo,
        hashParams: hashResult.params,
        failedAttempts: 0,
      });

      const sessionJwt = buildTestAuthToken(TEST_CLERK_ISSUER, "session-stepup-blocked");
      vi.spyOn(skoutAuth, "resolveAuth").mockResolvedValue({
        provider: "clerk",
        subject: "stepup_blocked_user",
        emailVerified: true,
      });
      vi.spyOn(skoutAuth, "resolveOrProvisionUser").mockResolvedValue({
        userId: user.id,
        userEmail: email,
        workspaceId: "11111111-1111-4111-8111-111111111111",
        role: "member",
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/step-up",
        headers: { authorization: `Bearer ${sessionJwt}` },
        payload: { password: plainPassword },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({
        code: AuthErrorCode.AUTH_ACCOUNT_BLOCKED,
      });

      await app.close();
    });

    it("returns 401 AUTH_INVALID_CREDENTIALS when user has no password credential", async () => {
      const app = await buildStepUpProbeApp(clerkOverrides, db);
      const email = `stepup-nocred-${Date.now()}@example.com`;

      const [user] = await db
        .insert(users)
        .values({
          email,
          fullName: "Step Up No Cred User",
          status: "active",
          isBlocked: false,
        })
        .returning();
      createdUserIds.push(user.id);

      const sessionJwt = buildTestAuthToken(TEST_CLERK_ISSUER, "session-stepup-nocred");
      vi.spyOn(skoutAuth, "resolveAuth").mockResolvedValue({
        provider: "clerk",
        subject: "stepup_nocred_user",
        emailVerified: true,
      });
      vi.spyOn(skoutAuth, "resolveOrProvisionUser").mockResolvedValue({
        userId: user.id,
        userEmail: email,
        workspaceId: "11111111-1111-4111-8111-111111111111",
        role: "member",
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/step-up",
        headers: { authorization: `Bearer ${sessionJwt}` },
        payload: { password: "SomeRandomPassword123!" },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({
        code: AuthErrorCode.AUTH_INVALID_CREDENTIALS,
      });

      await app.close();
    });
  });
});
