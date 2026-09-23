import { generateKeyPair, exportJWK, exportPKCS8 } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, schema } from "@skout/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { loadEnv } from "../config/env.js";
import { buildAuthCoreProbeApp } from "../test/auth-core-probe-app.js";
import type { MailOptions } from "../services/mail.service.js";
import { closeRedis, getRedis } from "../lib/redis.js";

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

const { users, userCredentials, authSessions, authEvents, workspaceMembers, workspaces, creditBalances, authVerificationTokens, authIdentities } = schema;

function cookieValue(response: { cookies: Array<{ name: string; value: string }> }, name: string): string | undefined {
  return response.cookies.find((c) => c.name === name)?.value;
}

function linkToken(mail: MailOptions | undefined): string {
  const match = mail?.text.match(/Link: \S+token=(\S+)/);
  if (!match?.[1]) throw new Error("verification link missing from mail");
  return decodeURIComponent(match[1]);
}

function otpCode(mail: MailOptions | undefined): string {
  const match = mail?.text.match(/Code: (\d{6})/);
  if (!match?.[1]) throw new Error("otp missing from mail");
  return match[1];
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

describe("auth-recovery.routes (AUTH-BE-15)", () => {
  const config = { ...loadEnv(), AUTH_REFRESH_TOKEN_PEPPER: "test-pepper-do-not-use-in-prod" };
  const { db, sql } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
  const createdUserEmails: string[] = [];
  let app: FastifyInstance;

  beforeAll(async () => {
    const redis = getRedis(config);
    if (redis) {
      const keys = await redis.keys("auth:recovery:*");
      if (keys.length > 0) await redis.del(...keys);
    }
    const key = await makeTestSigningKey();
    app = await buildAuthCoreProbeApp(db, {
      AUTH_REFRESH_TOKEN_PEPPER: config.AUTH_REFRESH_TOKEN_PEPPER,
      AUTH_JWT_PRIVATE_KEY: key.pem,
      AUTH_JWT_KID: "test-kid",
      AUTH_JWT_PUBLIC_KEY_SET: JSON.stringify({ keys: [key.jwk] }),
      NODE_ENV: "test",
    });
  });

  afterEach(async () => {
    sentMails.length = 0;
    const redis = getRedis(config);
    if (redis) {
      const keys = await redis.keys("auth:recovery:*");
      if (keys.length > 0) await redis.del(...keys);
    }
    for (const email of createdUserEmails) {
      const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
      if (!user) continue;
      await db.delete(authEvents).where(eq(authEvents.userId, user.id));
      await db.delete(authVerificationTokens).where(eq(authVerificationTokens.userId, user.id));
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
      await db.delete(userCredentials).where(eq(userCredentials.userId, user.id));
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
    await app.close();
    await closeRedis();
    await sql.end();
  });

  function freshEmail(label: string): string {
    const email = `be15-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
    createdUserEmails.push(email);
    return email;
  }

  async function signup(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/signup",
      payload: { email, password: "correct horse battery staple" },
    });
    expect(res.statusCode).toBe(201);
    return res.json().data.userId as string;
  }

  it("404s when AUTH_CUSTOM_ENABLED is false", async () => {
    const offApp = await buildAuthCoreProbeApp(db, {
      AUTH_CUSTOM_ENABLED: false,
      AUTH_REFRESH_TOKEN_PEPPER: config.AUTH_REFRESH_TOKEN_PEPPER,
      NODE_ENV: "test",
    });
    const routes = [
      "/api/v1/auth/verify-email/send",
      "/api/v1/auth/verify-email/confirm",
      "/api/v1/auth/password/forgot",
      "/api/v1/auth/password/reset",
      "/api/v1/auth/otp/send",
      "/api/v1/auth/otp/verify",
    ];
    for (const url of routes) {
      const res = await offApp.inject({ method: "POST", url, payload: {} });
      expect(res.statusCode, url).toBe(404);
    }
    await offApp.close();
  });

  it("answers known and unknown emails with the same body and does not put the token in the subject", async () => {
    const email = freshEmail("enum");
    await signup(email);
    const known = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify-email/send",
      payload: { email },
    });
    const unknown = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify-email/send",
      payload: { email: `missing-${Date.now()}@example.test` },
    });
    expect(known.statusCode).toBe(200);
    expect(unknown.statusCode).toBe(200);
    expect(JSON.stringify(known.json())).toBe(JSON.stringify(unknown.json()));

    const startedKnown = Date.now();
    await app.inject({ method: "POST", url: "/api/v1/auth/verify-email/send", payload: { email } });
    const knownMs = Date.now() - startedKnown;
    const startedUnknown = Date.now();
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify-email/send",
      payload: { email: `missing-timing-${Date.now()}@example.test` },
    });
    const unknownMs = Date.now() - startedUnknown;
    expect(Math.abs(knownMs - unknownMs)).toBeLessThan(750);
    expect(Math.abs(knownMs - unknownMs)).toBeLessThan(2500);
    // Two known-address sends happened above (the body-comparison call and the timing call).
    expect(sentMails).toHaveLength(2);
    expect(sentMails[0]?.subject).not.toMatch(/token=/);
    expect(sentMails[0]?.subject).not.toMatch(/\d{6}/);
  });

  it("does not make a known address wait for the SMTP round trip (fire-and-forget delivery)", async () => {
    // A mocked sendMail this slow would fail the 750ms timing assertion above if the route
    // awaited it before responding — this is what actually catches the enumeration timing leak
    // that a fast/instant mock (the default in this file) cannot. The delay is large (3s) and
    // the pass threshold generous (2s) so this stays reliable against this environment's own
    // baseline DB latency (real Postgres, no local optimization — other tests in this file take
    // 15-80s each) rather than a tight absolute cutoff that would be noise-sensitive here.
    const SMTP_DELAY_MS = 3000;
    const { sendMail } = await import("../services/mail.service.js");
    const mockedSendMail = vi.mocked(sendMail);
    mockedSendMail.mockImplementationOnce(async (_config, opts) => {
      await new Promise((resolve) => setTimeout(resolve, SMTP_DELAY_MS));
      sentMails.push(opts);
      return { sent: true };
    });

    const email = freshEmail("slow-smtp");
    await signup(email);
    sentMails.length = 0;

    const started = Date.now();
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/verify-email/send", payload: { email } });
    const elapsedMs = Date.now() - started;

    expect(res.statusCode).toBe(200);
    // Must return well before the mocked SMTP delay elapses — proves the response didn't wait
    // for it, without being tight enough to false-fail on this environment's own DB latency.
    expect(elapsedMs).toBeLessThan(SMTP_DELAY_MS - 1000);

    // The mail eventually goes out even though the response didn't wait for it.
    await new Promise((resolve) => setTimeout(resolve, SMTP_DELAY_MS));
    expect(sentMails).toHaveLength(1);
  });

  it("confirm verifies the email, issues a session, and rejects a replay", async () => {
    const email = freshEmail("confirm");
    const password = "correct horse battery staple";
    await signup(email);
    await app.inject({ method: "POST", url: "/api/v1/auth/verify-email/send", payload: { email } });
    const token = linkToken(sentMails[0]);

    const confirm = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify-email/confirm",
      payload: { token },
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().data.accessToken).toBeTruthy();
    expect(cookieValue(confirm, "skout_refresh")).toBeTruthy();

    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password } });
    expect(login.statusCode).toBe(200);

    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify-email/confirm",
      payload: { token },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().code).toBe("AUTH_TOKEN_INVALID");
  });

  it("rejects an expired verification token", async () => {
    const email = freshEmail("expired");
    const userId = await signup(email);
    await app.inject({ method: "POST", url: "/api/v1/auth/verify-email/send", payload: { email } });
    const token = linkToken(sentMails[0]);
    await db
      .update(authVerificationTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(authVerificationTokens.userId, userId));

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify-email/confirm",
      payload: { token },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("AUTH_TOKEN_INVALID");
  });

  it("reset changes the password, revokes existing sessions, and keeps the link if the new password is weak", async () => {
    const email = freshEmail("reset");
    const oldPassword = "correct horse battery staple";
    const newPassword = "a different long password";
    await signup(email);
    await app.inject({ method: "POST", url: "/api/v1/auth/verify-email/send", payload: { email } });
    const verify = linkToken(sentMails[0]);
    const confirmed = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify-email/confirm",
      payload: { token: verify },
    });
    const refresh = cookieValue(confirmed, "skout_refresh")!;
    const csrf = cookieValue(confirmed, "skout_csrf")!;

    sentMails.length = 0;
    await app.inject({ method: "POST", url: "/api/v1/auth/password/forgot", payload: { email } });
    const resetToken = linkToken(sentMails[0]);

    const weak = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password/reset",
      payload: { token: resetToken, password: "short" },
    });
    expect(weak.statusCode).toBe(400);

    const reset = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password/reset",
      payload: { token: resetToken, password: newPassword },
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().data.reset).toBe(true);
    expect(reset.json().data.accessToken).toBeUndefined();

    const refreshAfter = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      cookies: { skout_refresh: refresh, skout_csrf: csrf },
      headers: { "x-csrf-token": csrf },
    });
    expect(refreshAfter.statusCode).toBe(401);

    const oldLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: oldPassword },
    });
    expect(oldLogin.statusCode).toBe(401);

    const newLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: newPassword },
    });
    expect(newLogin.statusCode).toBe(200);

    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password/reset",
      payload: { token: resetToken, password: "yet another long password" },
    });
    expect(replay.statusCode).toBe(401);
  });

  it("otp verify signs the user in and a replay is rejected", async () => {
    const email = freshEmail("otp");
    await signup(email);
    await app.inject({ method: "POST", url: "/api/v1/auth/otp/send", payload: { email } });
    const code = otpCode(sentMails[0]);
    expect(sentMails[0]?.subject).not.toContain(code);

    const verify = await app.inject({
      method: "POST",
      url: "/api/v1/auth/otp/verify",
      payload: { email, code },
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().data.accessToken).toBeTruthy();

    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/auth/otp/verify",
      payload: { email, code },
    });
    expect(replay.statusCode).toBe(401);

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: "correct horse battery staple" },
    });
    expect(login.statusCode).toBe(200);
  });

  it("fails closed with 503 outside local dev when SMTP is not configured, and does not send a code", async () => {
    const key = await makeTestSigningKey();
    const prodApp = await buildAuthCoreProbeApp(db, {
      AUTH_REFRESH_TOKEN_PEPPER: config.AUTH_REFRESH_TOKEN_PEPPER,
      AUTH_JWT_PRIVATE_KEY: key.pem,
      AUTH_JWT_KID: "test-kid",
      AUTH_JWT_PUBLIC_KEY_SET: JSON.stringify({ keys: [key.jwk] }),
      NODE_ENV: "production",
      SMTP_HOST: "",
      SMTP_USERNAME: "",
      SMTP_PASSWORD: "",
    });
    const before = sentMails.length;
    const res = await prodApp.inject({
      method: "POST",
      url: "/api/v1/auth/otp/send",
      payload: { email: "anyone@example.test" },
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.stringify(res.json())).not.toMatch(/\d{6}/);
    expect(JSON.stringify(res.json())).not.toMatch(/token=/);
    expect(sentMails.length).toBe(before);
    await prodApp.close();
  });
});
