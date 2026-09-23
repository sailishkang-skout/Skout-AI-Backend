/**
 * AUTH-BE-15 — email verification, password reset, and email-OTP login.
 *
 * Behind AUTH_CUSTOM_ENABLED (default off). Send endpoints answer the same way for known and
 * unknown emails. Tokens live only as hashes. Confirm and OTP verify issue a session the same
 * way login does; reset revokes every session and does not sign the user in.
 *
 * Contract for FE-09 (§3). Shapes stay stable:
 * POST /auth/verify-email/send   {email}            → 200 {data:{status:"accepted"}}
 * POST /auth/verify-email/confirm {token}           → 200 {data:{accessToken, expiresIn}} + refresh cookie
 * POST /auth/password/forgot     {email}            → 200 {data:{status:"accepted"}}
 * POST /auth/password/reset      {token, password}  → 200 {data:{reset:true}}
 * POST /auth/otp/send            {email}            → 200 {data:{status:"accepted"}}
 * POST /auth/otp/verify          {email, code}      → 200 {data:{accessToken, expiresIn}} + refresh cookie
 * Links: {FRONTEND_URL}/verify-email?token= and {FRONTEND_URL}/reset-password?token=
 * Codes are 6 digits, links and codes expire in 15 minutes, single use.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { schema } from "@skout/db";
import { AuthErrorCode, authErrorResponse } from "@skout/auth";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { errorResponse, successResponse } from "../utils/http.js";
import { checkPasswordPolicy, hashPassword } from "../services/credential.service.js";
import { logEvent, revokeAllSessionsForUser } from "../services/session.service.js";
import { buildAuthCodeEmail, buildAuthLinkEmail, sendMail } from "../services/mail.service.js";
import {
  VERIFICATION_TTL_MINUTES,
  burnDummyVerification,
  consumeVerificationToken,
  issueVerificationToken,
  peekVerificationToken,
  mailUnavailableInDeployedEnv,
  markPasswordEmailVerified,
  recoveryRateLimited,
  type VerificationPurpose,
} from "../services/auth-recovery.service.js";
import { issueOwnAuthSession } from "./auth-core.routes.js";

const log = createLogger("auth-recovery.routes");
const { users, userCredentials } = schema;

const emailBody = z.object({ email: z.string().trim().email() });
const tokenBody = z.object({ token: z.string().trim().min(1) });
const resetBody = z.object({ token: z.string().trim().min(1), password: z.string() });
const otpVerifyBody = z.object({
  email: z.string().trim().email(),
  code: z.string().trim().regex(/^\d{6}$/),
});

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function requestMeta(request: FastifyRequest) {
  return { ip: request.ip, userAgent: request.headers["user-agent"] as string | undefined };
}

function appBase(config: Env): string {
  return (config.FRONTEND_URL || "http://localhost:3000").replace(/\/$/, "");
}

const ACCEPTED = { status: "accepted" as const };
const INVALID_MESSAGE = "Invalid or expired code.";

export async function authRecoveryRoutes(app: FastifyInstance) {
  function requireEnabled(reply: FastifyReply): boolean {
    if (!app.config.AUTH_CUSTOM_ENABLED) {
      reply.code(404).send(errorResponse("Not found", 404));
      return false;
    }
    return true;
  }

  async function sendForPurpose(
    request: FastifyRequest,
    reply: FastifyReply,
    purpose: VerificationPurpose,
    deliver: (email: string, raw: string) => ReturnType<typeof buildAuthLinkEmail>
  ) {
    if (!requireEnabled(reply)) return;
    const config = app.config;
    const db = app.db;
    if (!db) return reply.code(503).send(errorResponse("Database unavailable", 503));

    if (mailUnavailableInDeployedEnv(config)) {
      return reply.code(503).send(errorResponse("Email delivery is not configured", 503));
    }

    const parsed = emailBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send(errorResponse("Invalid email", 400, parsed.error.flatten()));
    }
    const email = normalizeEmail(parsed.data.email);
    const meta = requestMeta(request);

    if (await recoveryRateLimited(config, meta.ip, email)) {
      await logEvent(db, config, null, "recovery_rate_limited", meta, { purpose });
      return reply
        .code(429)
        .send(authErrorResponse(AuthErrorCode.AUTH_RATE_LIMITED, "Too many attempts. Try again later.", 429));
    }

    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (!user) {
      // Same hash + template work as a real send, then drop it. Nothing is stored or mailed.
      await burnDummyVerification(db, config, purpose);
      deliver(email, "0".repeat(43));
      await logEvent(db, config, null, "recovery_sent", meta, { purpose });
      return reply.send(successResponse(ACCEPTED));
    }

    const raw = await issueVerificationToken(db, config, user.id, purpose);
    const message = deliver(email, raw);
    // Anti-enumeration: the unknown-address branch above never touches the network (no SMTP
    // round trip), so awaiting sendMail here would make a known address measurably slower to
    // respond to in a real deployed env (SES calls are not instant). Fire-and-forget instead —
    // the response is identical either way, and delivery failures are still logged.
    void sendMail(config, message).catch((err) => logSafeMailFailure(err));
    await logEvent(db, config, user.id, "recovery_sent", meta, { purpose });
    return reply.send(successResponse(ACCEPTED));
  }

  app.post(
    "/auth/verify-email/send",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (request, reply) =>
      sendForPurpose(request, reply, "email_verify", (email, raw) =>
        buildAuthLinkEmail({
          to: email,
          url: `${appBase(app.config)}/verify-email?token=${encodeURIComponent(raw)}`,
          title: "Verify your Skout AI email",
          intro: "Confirm this is your email address to finish creating your Skout AI account.",
          buttonLabel: "Verify email",
          expiresInMinutes: VERIFICATION_TTL_MINUTES,
        })
      )
  );

  app.post(
    "/auth/password/forgot",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (request, reply) =>
      sendForPurpose(request, reply, "password_reset", (email, raw) =>
        buildAuthLinkEmail({
          to: email,
          url: `${appBase(app.config)}/reset-password?token=${encodeURIComponent(raw)}`,
          title: "Reset your Skout AI password",
          intro: "We received a request to reset your Skout AI password.",
          buttonLabel: "Reset password",
          expiresInMinutes: VERIFICATION_TTL_MINUTES,
        })
      )
  );

  app.post(
    "/auth/otp/send",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (request, reply) =>
      sendForPurpose(request, reply, "email_otp", (email, raw) =>
        buildAuthCodeEmail({
          to: email,
          code: raw,
          title: "Your Skout AI sign-in code",
          intro: "Use this code to sign in to Skout AI.",
          expiresInMinutes: VERIFICATION_TTL_MINUTES,
        })
      )
  );

  app.post(
    "/auth/verify-email/confirm",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      if (!requireEnabled(reply)) return;
      const db = app.db;
      if (!db) return reply.code(503).send(errorResponse("Database unavailable", 503));
      const parsed = tokenBody.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send(errorResponse("Invalid token", 400));
      }
      const userId = await consumeVerificationToken(db, app.config, "email_verify", parsed.data.token);
      if (!userId) {
        return reply.code(401).send(authErrorResponse(AuthErrorCode.AUTH_TOKEN_INVALID, INVALID_MESSAGE, 401));
      }
      return finishVerifiedSession(app, request, reply, userId);
    }
  );

  app.post(
    "/auth/otp/verify",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      if (!requireEnabled(reply)) return;
      const db = app.db;
      if (!db) return reply.code(503).send(errorResponse("Database unavailable", 503));
      const parsed = otpVerifyBody.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send(errorResponse("Invalid code", 400));
      }
      const email = normalizeEmail(parsed.data.email);
      const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
      if (!user) {
        await burnDummyVerification(db, app.config, "email_otp");
        return reply.code(401).send(authErrorResponse(AuthErrorCode.AUTH_TOKEN_INVALID, INVALID_MESSAGE, 401));
      }
      const userId = await consumeVerificationToken(db, app.config, "email_otp", parsed.data.code, user.id);
      if (!userId || userId !== user.id) {
        return reply.code(401).send(authErrorResponse(AuthErrorCode.AUTH_TOKEN_INVALID, INVALID_MESSAGE, 401));
      }
      return finishVerifiedSession(app, request, reply, userId);
    }
  );

  app.post(
    "/auth/password/reset",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      if (!requireEnabled(reply)) return;
      const config = app.config;
      const db = app.db;
      if (!db) return reply.code(503).send(errorResponse("Database unavailable", 503));
      const parsed = resetBody.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send(errorResponse("Invalid reset payload", 400));
      }

      const peeked = await peekVerificationToken(db, config, "password_reset", parsed.data.token);
      if (!peeked) {
        return reply.code(401).send(authErrorResponse(AuthErrorCode.AUTH_TOKEN_INVALID, INVALID_MESSAGE, 401));
      }

      const policy = checkPasswordPolicy(parsed.data.password);
      if (!policy.ok) {
        return reply.code(400).send(errorResponse(policy.reasons[0] ?? "Password does not meet policy", 400, policy));
      }

      const userId = await consumeVerificationToken(db, config, "password_reset", parsed.data.token);
      if (!userId) {
        return reply.code(401).send(authErrorResponse(AuthErrorCode.AUTH_TOKEN_INVALID, INVALID_MESSAGE, 401));
      }

      const [user] = await db
        .select({ id: users.id, email: users.email, status: users.status, isBlocked: users.isBlocked })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!user || user.status !== "active" || user.isBlocked) {
        return reply
          .code(403)
          .send(authErrorResponse(AuthErrorCode.AUTH_ACCOUNT_BLOCKED, "Account is inactive or blocked", 403));
      }

      const hashed = await hashPassword(parsed.data.password);
      const now = new Date();
      const [updated] = await db
        .update(userCredentials)
        .set({
          passwordHash: hashed.hash,
          hashAlgo: hashed.algo,
          hashParams: hashed.params,
          passwordUpdatedAt: now,
          mustReset: false,
          failedAttempts: 0,
          lockedUntil: null,
          updatedAt: now,
        })
        .where(eq(userCredentials.userId, user.id))
        .returning({ userId: userCredentials.userId });
      if (!updated) {
        await db.insert(userCredentials).values({
          userId: user.id,
          passwordHash: hashed.hash,
          hashAlgo: hashed.algo,
          hashParams: hashed.params,
          mustReset: false,
        });
      }

      await revokeAllSessionsForUser(db, config, user.id, "password_changed", requestMeta(request));
      await markPasswordEmailVerified(db, user.id, user.email);
      await logEvent(db, config, user.id, "password_reset", requestMeta(request), {});
      return reply.send(successResponse({ reset: true }));
    }
  );
}

async function finishVerifiedSession(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string
) {
  const db = app.db;
  if (!db) return reply.code(503).send(errorResponse("Database unavailable", 503));
  const [user] = await db
    .select({ id: users.id, email: users.email, status: users.status, isBlocked: users.isBlocked })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user || user.status !== "active" || user.isBlocked) {
    return reply
      .code(403)
      .send(authErrorResponse(AuthErrorCode.AUTH_ACCOUNT_BLOCKED, "Account is inactive or blocked", 403));
  }
  await markPasswordEmailVerified(db, user.id, user.email);
  const meta = requestMeta(request);
  const session = await issueOwnAuthSession(db, app.config, reply, user.id, meta);
  await logEvent(db, app.config, user.id, "login_success", meta, { email: user.email, sessionId: session.sessionId });
  return reply.send(successResponse({ accessToken: session.accessToken, expiresIn: session.expiresIn }));
}

function logSafeMailFailure(err: unknown): void {
  log.error("email delivery failed", err);
}
