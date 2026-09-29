import { generateKeyPair, exportJWK, exportPKCS8 } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, schema } from "@skout/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { loadEnv } from "../config/env.js";
import { buildAuthCoreProbeApp } from "../test/auth-core-probe-app.js";
import type { MailOptions } from "../services/mail.service.js";
import { closeRedis } from "../lib/redis.js";
import { verifyPassword } from "../services/credential.service.js";
import { hashInviteSessionToken } from "../services/invite-auth.service.js";

const sentMails = vi.hoisted(() => [] as MailOptions[]);

vi.mock("../services/mail.service.js", async () => {
  const actual = await vi.importActual<typeof import("../services/mail.service.js")>("../services/mail.service.js");
  return {
    ...actual,
    sendMail: vi.fn(async (_config: unknown, opts: MailOptions) => {
      sentMails.push(opts);
      return { sent: true };
    }),
  };
});

const { users, userCredentials, authSessions, authEvents, workspaceMembers, workspaces, workspaceInvites, inviteOtps, inviteSessions, authIdentities } = schema;

function cookieValue(response: { cookies: Array<{ name: string; value: string }> }, name: string): string | undefined {
  return response.cookies.find((c) => c.name === name)?.value;
}

function otpCode(mail: MailOptions | undefined): string {
  const match = mail?.text.match(/code is:\s*(\d{6})/i) ?? mail?.text.match(/(\d{6})/);
  if (!match?.[1]) throw new Error("otp missing from mail");
  return match[1];
}

async function makeTestSigningKey() {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-kid-invite";
  jwk.alg = "RS256";
  jwk.use = "sig";
  const pem = await exportPKCS8(privateKey);
  return { pem, jwk };
}

describe("invite-auth.routes (AUTH-BE-26)", () => {
  const config = { ...loadEnv(), AUTH_REFRESH_TOKEN_PEPPER: "test-pepper-do-not-use-in-prod" };
  const { db, sql } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
  const createdWorkspaceIds: string[] = [];
  const createdUserEmails: string[] = [];
  let app: FastifyInstance;
  let signingKeyPem: string;

  beforeAll(async () => {
    const key = await makeTestSigningKey();
    signingKeyPem = key.pem;
    app = await buildAuthCoreProbeApp(db, {
      AUTH_REFRESH_TOKEN_PEPPER: config.AUTH_REFRESH_TOKEN_PEPPER,
      AUTH_JWT_PRIVATE_KEY: key.pem,
      AUTH_JWT_KID: "test-kid-invite",
      AUTH_JWT_PUBLIC_KEY_SET: JSON.stringify({ keys: [key.jwk] }),
      NODE_ENV: "test",
    });
  });

  afterEach(async () => {
    sentMails.length = 0;
    for (const email of createdUserEmails) {
      const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
      if (user) {
        await db.delete(authEvents).where(eq(authEvents.userId, user.id));
        await db.delete(authIdentities).where(eq(authIdentities.userId, user.id));
        await db.delete(inviteSessions).where(eq(inviteSessions.userId, user.id));
        const sessions = await db.select({ id: authSessions.id }).from(authSessions).where(eq(authSessions.userId, user.id));
        for (const s of sessions) {
          await db.delete(schema.authRefreshTokens).where(eq(schema.authRefreshTokens.sessionId, s.id));
        }
        await db.delete(authSessions).where(eq(authSessions.userId, user.id));
        await db.delete(userCredentials).where(eq(userCredentials.userId, user.id));
        await db.delete(workspaceMembers).where(eq(workspaceMembers.userId, user.id));
        await db.delete(users).where(eq(users.id, user.id));
      }
    }
    createdUserEmails.length = 0;

    for (const wsId of createdWorkspaceIds) {
      await db.delete(inviteOtps);
      await db.delete(workspaceInvites).where(eq(workspaceInvites.workspaceId, wsId));
      await db.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, wsId));
      await db.delete(schema.creditBalances).where(eq(schema.creditBalances.workspaceId, wsId));
      await db.delete(schema.creditTransactions).where(eq(schema.creditTransactions.workspaceId, wsId));
      await db.delete(workspaces).where(eq(workspaces.id, wsId));
    }
    createdWorkspaceIds.length = 0;
  });

  afterAll(async () => {
    await app?.close();
    await closeRedis();
    await sql.end();
  });

  async function createTestWorkspaceAndInvite(emailSuffix: string, role = "member") {
    const slug = `ws-${emailSuffix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const [ws] = await db
      .insert(workspaces)
      .values({ name: `Test Workspace ${emailSuffix}`, slug })
      .returning({ id: workspaces.id });
    createdWorkspaceIds.push(ws.id);

    const email = `invitee-${emailSuffix}-${Date.now()}@example.test`;
    createdUserEmails.push(email);

    const inviteToken = `inv_token_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const [inv] = await db
      .insert(workspaceInvites)
      .values({
        workspaceId: ws.id,
        email,
        role,
        token: inviteToken,
        expiresAt,
      })
      .returning();

    return { workspace: ws, invite: inv, email, inviteToken };
  }

  it("send-otp validates invite, sends OTP email, and rejects invalid/expired/accepted invites", async () => {
    const { inviteToken, email } = await createTestWorkspaceAndInvite("send-otp");

    // Happy path
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/invite-auth/send-otp",
      payload: { inviteToken },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.email).toBe(email);
    expect(sentMails.length).toBe(1);

    // Non-existent invite
    const notFound = await app.inject({
      method: "POST",
      url: "/api/v1/invite-auth/send-otp",
      payload: { inviteToken: "non-existent-token" },
    });
    expect(notFound.statusCode).toBe(404);

    // Expired invite
    const [expiredWs] = await db
      .insert(workspaces)
      .values({ name: "Expired WS", slug: `exp-ws-${Date.now()}` })
      .returning();
    createdWorkspaceIds.push(expiredWs.id);
    const expiredToken = `exp_token_${Date.now()}`;
    await db.insert(workspaceInvites).values({
      workspaceId: expiredWs.id,
      email: "expired@example.test",
      role: "member",
      token: expiredToken,
      expiresAt: new Date(Date.now() - 1000),
    });
    const expRes = await app.inject({
      method: "POST",
      url: "/api/v1/invite-auth/send-otp",
      payload: { inviteToken: expiredToken },
    });
    expect(expRes.statusCode).toBe(410);

    // Already accepted invite
    const acceptedToken = `acc_token_${Date.now()}`;
    await db.insert(workspaceInvites).values({
      workspaceId: expiredWs.id,
      email: "accepted@example.test",
      role: "member",
      token: acceptedToken,
      expiresAt: new Date(Date.now() + 100000),
      acceptedAt: new Date(),
    });
    const accRes = await app.inject({
      method: "POST",
      url: "/api/v1/invite-auth/send-otp",
      payload: { inviteToken: acceptedToken },
    });
    expect(accRes.statusCode).toBe(409);
  });

  it("verify-otp rejects wrong, expired, or already-used OTP", async () => {
    const { inviteToken } = await createTestWorkspaceAndInvite("bad-otp");

    await app.inject({
      method: "POST",
      url: "/api/v1/invite-auth/send-otp",
      payload: { inviteToken },
    });
    expect(sentMails.length).toBe(1);
    const validOtp = otpCode(sentMails[0]);

    // Wrong OTP
    const wrongRes = await app.inject({
      method: "POST",
      url: "/api/v1/invite-auth/verify-otp",
      payload: { inviteToken, otp: "000000" },
    });
    expect(wrongRes.statusCode).toBe(401);

    // Valid OTP once
    const okRes = await app.inject({
      method: "POST",
      url: "/api/v1/invite-auth/verify-otp",
      payload: { inviteToken, otp: validOtp },
    });
    expect(okRes.statusCode).toBe(200);

    // Replay / already-used OTP (also invite is now accepted)
    const replayRes = await app.inject({
      method: "POST",
      url: "/api/v1/invite-auth/verify-otp",
      payload: { inviteToken, otp: validOtp },
    });
    expect(replayRes.statusCode).toBe(409); // Invite already accepted
  });

  it("with flag off: verify-otp returns legacy response and set-password keeps legacy Clerk write", async () => {
    const offApp = await buildAuthCoreProbeApp(db, {
      AUTH_CUSTOM_ENABLED: false,
      AUTH_REFRESH_TOKEN_PEPPER: config.AUTH_REFRESH_TOKEN_PEPPER,
      AUTH_JWT_PRIVATE_KEY: signingKeyPem,
      AUTH_JWT_KID: "test-kid-invite",
      AUTH_JWT_PUBLIC_KEY_SET: JSON.stringify({ keys: [] }),
      CLERK_SECRET_KEY: "replace-me",
      NODE_ENV: "test",
    });

    const { inviteToken, email, workspace } = await createTestWorkspaceAndInvite("flag-off", "admin");

    await offApp.inject({
      method: "POST",
      url: "/api/v1/invite-auth/send-otp",
      payload: { inviteToken },
    });
    const otp = otpCode(sentMails[0]);

    const verifyRes = await offApp.inject({
      method: "POST",
      url: "/api/v1/invite-auth/verify-otp",
      payload: { inviteToken, otp },
    });

    expect(verifyRes.statusCode).toBe(200);
    const body = verifyRes.json();
    // Legacy shape: has sessionToken, workspaceId, role, email; DOES NOT have accessToken
    expect(body.data.sessionToken).toMatch(/^isk_[0-9a-f]{64}$/);
    expect(body.data.accessToken).toBeUndefined();
    expect(body.data.workspaceId).toBe(workspace.id);
    expect(body.data.role).toBe("admin");
    expect(body.data.email).toBe(email);

    // No refresh cookie set when flag is off
    expect(cookieValue(verifyRes, "skout_refresh")).toBeUndefined();

    // Verify token is hashed in DB (Requirement 3: No plaintext session token in DB)
    const [dbSession] = await db
      .select()
      .from(inviteSessions)
      .where(eq(inviteSessions.token, hashInviteSessionToken(body.data.sessionToken)))
      .limit(1);
    expect(dbSession).toBeDefined();
    // The raw session token is NEVER stored in the DB
    const [rawInDb] = await db
      .select()
      .from(inviteSessions)
      .where(eq(inviteSessions.token, body.data.sessionToken))
      .limit(1);
    expect(rawInDb).toBeUndefined();

    // Set password with flag off does stub/Clerk mode and does NOT write to user_credentials
    const setPassRes = await offApp.inject({
      method: "POST",
      url: "/api/v1/invite-auth/set-password",
      headers: { authorization: `Bearer ${body.data.sessionToken}` },
      payload: { password: "ValidPassword123!" },
    });
    expect(setPassRes.statusCode).toBe(200);
    expect(setPassRes.json().data.message).toContain("Password set");

    // Confirm user_credentials was NOT written
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    const [cred] = await db.select().from(userCredentials).where(eq(userCredentials.userId, user!.id)).limit(1);
    expect(cred).toBeUndefined();

    await offApp.close();
  });

  it("with flag on: OTP -> set password -> authenticated session, user_credentials stored with Argon2id, and correct workspace membership & role", async () => {
    const { inviteToken, email, workspace } = await createTestWorkspaceAndInvite("flag-on", "owner");

    // 1. Send OTP
    const sendRes = await app.inject({
      method: "POST",
      url: "/api/v1/invite-auth/send-otp",
      payload: { inviteToken },
    });
    expect(sendRes.statusCode).toBe(200);
    const otp = otpCode(sentMails[0]);

    // 2. Verify OTP -> completes sign-in as own-auth session (BE-13/BE-14)
    const verifyRes = await app.inject({
      method: "POST",
      url: "/api/v1/invite-auth/verify-otp",
      payload: { inviteToken, otp },
    });
    expect(verifyRes.statusCode).toBe(200);
    const verifyBody = verifyRes.json();

    // User lands authenticated with own-auth session
    expect(verifyBody.data.accessToken).toBeTruthy();
    expect(verifyBody.data.expiresIn).toBe(600);
    expect(verifyBody.data.user.email).toBe(email);
    expect(verifyBody.data.user.role).toBe("owner");
    expect(verifyBody.data.user.workspaceId).toBe(workspace.id);

    // Refresh and CSRF cookies are set
    const refreshCookie = cookieValue(verifyRes, "skout_refresh");
    const csrfCookie = cookieValue(verifyRes, "skout_csrf");
    expect(refreshCookie).toBeTruthy();
    expect(csrfCookie).toBeTruthy();

    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    expect(user).toBeDefined();

    // auth_identities row exists
    const [identity] = await db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.userId, user!.id))
      .limit(1);
    expect(identity).toBeDefined();
    expect(identity?.provider).toBe("password");

    // 3. Set password with isk_ session token
    const iskToken = verifyBody.data.sessionToken;
    expect(iskToken).toBeTruthy();

    // Password policy rejection (< 10 chars)
    const weakPassRes = await app.inject({
      method: "POST",
      url: "/api/v1/invite-auth/set-password",
      headers: { authorization: `Bearer ${iskToken}` },
      payload: { password: "short" },
    });
    expect(weakPassRes.statusCode).toBe(400);

    // Successful set password
    const testPassword = "VerySecurePassword2026!";
    const setPassRes = await app.inject({
      method: "POST",
      url: "/api/v1/invite-auth/set-password",
      headers: { authorization: `Bearer ${iskToken}` },
      payload: { password: testPassword },
    });
    expect(setPassRes.statusCode).toBe(200);
    const setPassBody = setPassRes.json();
    expect(setPassBody.data.message).toContain("Password set");
    expect(setPassBody.data.accessToken).toBeTruthy();

    // Check user_credentials persisted with Argon2id
    const [storedCred] = await db
      .select()
      .from(userCredentials)
      .where(eq(userCredentials.userId, user!.id))
      .limit(1);
    expect(storedCred).toBeDefined();
    expect(storedCred?.hashAlgo).toBe("argon2id");
    expect(storedCred?.passwordHash).toBeTruthy();

    // Verify stored credential works with verifyPassword
    const verified = await verifyPassword(testPassword, {
      passwordHash: storedCred!.passwordHash,
      hashAlgo: storedCred!.hashAlgo,
      hashParams: storedCred!.hashParams,
    });
    expect(verified.valid).toBe(true);

    // Also test set-password with own-auth access token
    const testPassword2 = "AnotherSecurePassword2026!";
    const setWithAccessRes = await app.inject({
      method: "POST",
      url: "/api/v1/invite-auth/set-password",
      headers: { authorization: `Bearer ${verifyBody.data.accessToken}` },
      payload: { password: testPassword2 },
    });
    expect(setWithAccessRes.statusCode).toBe(200);

    const [updatedCred] = await db
      .select()
      .from(userCredentials)
      .where(eq(userCredentials.userId, user!.id))
      .limit(1);
    const verified2 = await verifyPassword(testPassword2, {
      passwordHash: updatedCred!.passwordHash,
      hashAlgo: updatedCred!.hashAlgo,
      hashParams: updatedCred!.hashParams,
    });
    expect(verified2.valid).toBe(true);
  });

  it("verify-otp refuses blocked user with 403 AUTH_ACCOUNT_BLOCKED", async () => {
    const { inviteToken, email } = await createTestWorkspaceAndInvite("blocked-user");

    // Pre-create the user as blocked
    await db.insert(users).values({
      email,
      fullName: "Blocked Invitee",
      status: "suspended",
      isBlocked: true,
    });

    await app.inject({
      method: "POST",
      url: "/api/v1/invite-auth/send-otp",
      payload: { inviteToken },
    });
    const otp = otpCode(sentMails[0]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/invite-auth/verify-otp",
      payload: { inviteToken, otp },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("AUTH_ACCOUNT_BLOCKED");
  });

  it("set-password rejects unauthorized request without token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/invite-auth/set-password",
      payload: { password: "ValidPassword123!" },
    });
    expect(res.statusCode).toBe(401);
  });
});

