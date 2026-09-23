/**
 * AUTH-BE-14 — core own-auth endpoints: signup, login, refresh, logout, logout-all, me.
 *
 * Behind AUTH_CUSTOM_ENABLED (default off, §3/Ground Rule 8) — every route here 404s until the
 * flag is on, so this ships dark alongside the still-authoritative Clerk path.
 *
 * These routes are deliberately NOT reached through the global Clerk-only preHandler
 * (plugins/auth.ts's authPlugin): signup/login/refresh are unauthenticated by definition, logout
 * reads a refresh *cookie* rather than a Bearer token, and logout-all/me carry an own-auth
 * *access* token that plugins/auth.ts's resolveAuth() cannot verify yet (that dispatch wiring is
 * AUTH-BE-19's job — see token.service.ts's TODO). All six routes are added to
 * plugins/auth.ts's isPublicRoute() allowlist and each does its own verification inline.
 *
 * Scope note: email-verification enforcement (refusing login with AUTH_EMAIL_NOT_VERIFIED) is
 * explicitly deferred here — the ticket doc says BE-14 "starts refusing password login for
 * unverified emails once [BE-15/FE-09] lands", and BE-15 (the endpoints that actually verify an
 * email) is a separate, not-yet-built ticket. Signups are usable immediately so this can ship
 * without a dependency that doesn't exist yet; auth_identities.emailVerifiedAt is still recorded
 * (null at signup) so BE-15 has something to update and this gate is a one-line addition later.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { schema } from "@skout/db";
import type { Db } from "@skout/db";
import { resolveOrProvisionUser } from "@skout/auth";
import { AuthErrorCode, authErrorResponse, HttpError } from "@skout/auth";
import type { Env } from "../config/env.js";
import { errorResponse, successResponse } from "../utils/http.js";
import {
  checkPasswordPolicy,
  hashPassword,
  verifyPassword,
  verifyUnknownUser,
} from "../services/credential.service.js";
import { signAccessToken, verifyAccessToken, ACCESS_TOKEN_TTL_SECONDS } from "../services/token.service.js";
import {
  createSession,
  isSessionRevoked,
  logEvent,
  revokeAllSessionsForUser,
  revokeSession,
  rotateRefreshToken,
} from "../services/session.service.js";
import {
  ACCOUNT_FAILURE_THRESHOLD,
  ACCOUNT_LOCK_SECONDS,
  clearIpFailures,
  isIpLocked,
  recordIpFailureAndCheckLocked,
} from "../services/auth-lockout.service.js";

const { users, userCredentials, authRefreshTokens } = schema;

const REFRESH_COOKIE_NAME = "skout_refresh";
const CSRF_COOKIE_NAME = "skout_csrf";
const COOKIE_PATH = "/api/v1/auth";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function requestMeta(request: FastifyRequest) {
  return { ip: request.ip, userAgent: request.headers["user-agent"] as string | undefined };
}

function refreshCookieOptions(config: Env) {
  return {
    httpOnly: true,
    secure: config.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: COOKIE_PATH,
  };
}

/** Non-HttpOnly by design — the double-submit CSRF pattern requires client JS to read this
 *  value back and echo it in the x-csrf-token header; it is not itself a secret credential
 *  (the refresh cookie is, and stays HttpOnly). */
function csrfCookieOptions(config: Env) {
  return {
    httpOnly: false,
    secure: config.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: COOKIE_PATH,
  };
}

function newCsrfToken(): string {
  return randomBytes(24).toString("base64url");
}

function setAuthCookies(reply: FastifyReply, config: Env, refreshToken: string): string {
  const csrf = newCsrfToken();
  reply.setCookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions(config));
  reply.setCookie(CSRF_COOKIE_NAME, csrf, csrfCookieOptions(config));
  return csrf;
}

function clearAuthCookies(reply: FastifyReply, config: Env): void {
  reply.clearCookie(REFRESH_COOKIE_NAME, { path: COOKIE_PATH });
  reply.clearCookie(CSRF_COOKIE_NAME, { path: COOKIE_PATH });
}

/** Double-submit CSRF check for the two cookie-authenticated, state-changing endpoints
 *  (refresh, logout) — the cookie value and the header must both be present and match. A
 *  cross-site form/script can make the browser send the cookie automatically but cannot read
 *  it to also set the header, which is what breaks a forged request. */
function checkCsrf(request: FastifyRequest): boolean {
  const cookieValue = request.cookies?.[CSRF_COOKIE_NAME];
  const header = request.headers["x-csrf-token"];
  if (!cookieValue || typeof header !== "string" || !header) return false;
  return cookieValue === header;
}

/** Shared verification for the two Bearer-authenticated routes (logout-all, me): verify the
 *  own-auth access token, confirm its session hasn't been revoked, and load the user +
 *  workspace membership. Throws HttpError with a §3 code as its message on any failure — callers
 *  turn that into the auth error envelope. */
async function requireOwnAuthUser(
  request: FastifyRequest,
  app: FastifyInstance
): Promise<{ userId: string; sessionId: string; email: string; fullName: string | null; workspaceId?: string; role?: string }> {
  const config = app.config;
  const authorization = request.headers.authorization;
  const token =
    typeof authorization === "string" && authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : undefined;
  if (!token) {
    throw new HttpError(AuthErrorCode.AUTH_MISSING_TOKEN, 401);
  }

  const verified = await verifyAccessToken(token, config); // throws AUTH_TOKEN_INVALID/EXPIRED
  const db = app.db;
  if (!db) throw new HttpError("Database unavailable", 503);

  const revoked = await isSessionRevoked(db, config, verified.sid);
  if (revoked) {
    throw new HttpError(AuthErrorCode.AUTH_SESSION_REVOKED, 401);
  }

  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      status: users.status,
      isBlocked: users.isBlocked,
    })
    .from(users)
    .where(eq(users.id, verified.sub))
    .limit(1);

  if (!user || user.status !== "active" || user.isBlocked) {
    throw new HttpError(AuthErrorCode.AUTH_ACCOUNT_BLOCKED, 403);
  }

  const [membership] = await db
    .select({ workspaceId: schema.workspaceMembers.workspaceId, role: schema.workspaceMembers.role })
    .from(schema.workspaceMembers)
    .where(eq(schema.workspaceMembers.userId, user.id))
    .limit(1);

  return {
    userId: user.id,
    sessionId: verified.sid,
    email: user.email,
    fullName: user.fullName,
    workspaceId: membership?.workspaceId,
    role: membership?.role,
  };
}

function sendAuthHttpError(reply: FastifyReply, err: HttpError) {
  const code = (Object.values(AuthErrorCode) as string[]).includes(err.message)
    ? (err.message as (typeof AuthErrorCode)[keyof typeof AuthErrorCode])
    : AuthErrorCode.AUTH_TOKEN_INVALID;
  return reply.code(err.statusCode).send(authErrorResponse(code, err.message, err.statusCode));
}

const signupBodySchema = z.object({
  email: z.string().trim().email(),
  password: z.string(),
  fullName: z.string().trim().min(1).max(200).optional(),
});

const loginBodySchema = z.object({
  email: z.string().trim().email(),
  password: z.string(),
});

export async function authCoreRoutes(app: FastifyInstance) {
  function requireEnabled(reply: FastifyReply): boolean {
    if (!app.config.AUTH_CUSTOM_ENABLED) {
      reply.code(404).send(errorResponse("Not found", 404));
      return false;
    }
    return true;
  }

  // --- POST /auth/signup --------------------------------------------------------------
  app.post(
    "/auth/signup",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!requireEnabled(reply)) return;
      const config = app.config;
      const db = app.db;
      if (!db) return reply.code(503).send(errorResponse("Database unavailable", 503));

      const parsed = signupBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send(errorResponse("Invalid signup payload", 400, parsed.error.flatten()));
      }
      const email = normalizeEmail(parsed.data.email);
      const meta = requestMeta(request);

      if (await isIpLocked(config, meta.ip)) {
        await logEvent(db, config, null, "signup_failure", meta, { email, reason: "ip_rate_limited" });
        return reply
          .code(429)
          .send(authErrorResponse(AuthErrorCode.AUTH_RATE_LIMITED, "Too many attempts. Try again later.", 429));
      }

      const policy = checkPasswordPolicy(parsed.data.password);
      if (!policy.ok) {
        await logEvent(db, config, null, "signup_failure", meta, { email, reason: "policy_rejected" });
        return reply.code(400).send(errorResponse(policy.reasons[0] ?? "Password does not meet policy", 400, policy));
      }

      // Pre-check: an existing password credential means this email already has an own-auth
      // account — signup must not silently overwrite it (that would be an account takeover by
      // anyone who merely knows the email). A user row with NO credentials yet (lazily
      // provisioned by Clerk/invite/import) is fine to attach a password to.
      const [existingUser] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      if (existingUser) {
        const [existingCred] = await db
          .select({ userId: userCredentials.userId })
          .from(userCredentials)
          .where(eq(userCredentials.userId, existingUser.id))
          .limit(1);
        if (existingCred) {
          await recordIpFailureAndCheckLocked(config, meta.ip);
          await logEvent(db, config, existingUser.id, "signup_failure", meta, {
            email,
            reason: "account_exists",
          });
          return reply.code(409).send(errorResponse("An account with this email already exists.", 409));
        }
      }

      const hashResult = await hashPassword(parsed.data.password);

      const result = await resolveOrProvisionUser(db, {
        provider: "password",
        subject: email,
        email,
        emailVerified: false,
        name: parsed.data.fullName,
      });

      const [credRow] = await db
        .insert(userCredentials)
        .values({
          userId: result.userId,
          passwordHash: hashResult.hash,
          hashAlgo: hashResult.algo,
          hashParams: hashResult.params,
        })
        .onConflictDoNothing({ target: userCredentials.userId })
        .returning({ userId: userCredentials.userId });

      if (!credRow) {
        // Lost a race against a concurrent signup/credential-attach for the same user.
        await logEvent(db, config, result.userId, "signup_failure", meta, {
          email,
          reason: "account_exists_race",
        });
        return reply.code(409).send(errorResponse("An account with this email already exists.", 409));
      }

      await clearIpFailures(config, meta.ip);
      await logEvent(db, config, result.userId, "signup", meta, { email });

      return reply.code(201).send(successResponse({ userId: result.userId }));
    }
  );

  // --- POST /auth/login ----------------------------------------------------------------
  app.post(
    "/auth/login",
    { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!requireEnabled(reply)) return;
      const config = app.config;
      const db = app.db;
      if (!db) return reply.code(503).send(errorResponse("Database unavailable", 503));

      const parsed = loginBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send(errorResponse("Invalid login payload", 400, parsed.error.flatten()));
      }
      const email = normalizeEmail(parsed.data.email);
      const meta = requestMeta(request);

      const genericInvalid = () =>
        reply
          .code(401)
          .send(
            authErrorResponse(AuthErrorCode.AUTH_INVALID_CREDENTIALS, "Invalid email or password.", 401)
          );

      if (await isIpLocked(config, meta.ip)) {
        await logEvent(db, config, null, "login_failure", meta, { email, reason: "ip_rate_limited" });
        return reply
          .code(429)
          .send(authErrorResponse(AuthErrorCode.AUTH_RATE_LIMITED, "Too many attempts. Try again later.", 429));
      }

      const [row] = await db
        .select({
          userId: users.id,
          email: users.email,
          status: users.status,
          isBlocked: users.isBlocked,
          passwordHash: userCredentials.passwordHash,
          hashAlgo: userCredentials.hashAlgo,
          hashParams: userCredentials.hashParams,
          failedAttempts: userCredentials.failedAttempts,
          lockedUntil: userCredentials.lockedUntil,
        })
        .from(users)
        .innerJoin(userCredentials, eq(userCredentials.userId, users.id))
        .where(eq(users.email, email))
        .limit(1);

      if (!row) {
        // No account (or no password credential) for this email — run the same-cost dummy
        // comparison so response time can't distinguish "no such account" from "wrong password".
        await verifyUnknownUser(parsed.data.password);
        const ipLocked = await recordIpFailureAndCheckLocked(config, meta.ip);
        await logEvent(db, config, null, "login_failure", meta, { email, reason: "no_account" });
        if (ipLocked) {
          return reply
            .code(429)
            .send(authErrorResponse(AuthErrorCode.AUTH_RATE_LIMITED, "Too many attempts. Try again later.", 429));
        }
        return genericInvalid();
      }

      if (row.lockedUntil && row.lockedUntil.getTime() > Date.now()) {
        // Locked from repeated failures — signalled as rate-limited (not a distinct "locked"
        // code) so this can't be used to distinguish "wrong password" from "account locked".
        await logEvent(db, config, row.userId, "login_failure", meta, { email, reason: "account_locked" });
        return reply
          .code(429)
          .send(authErrorResponse(AuthErrorCode.AUTH_RATE_LIMITED, "Too many attempts. Try again later.", 429));
      }

      const verify = await verifyPassword(parsed.data.password, {
        passwordHash: row.passwordHash,
        hashAlgo: row.hashAlgo,
        hashParams: row.hashParams,
      });

      if (!verify.valid) {
        const nextFailed = row.failedAttempts + 1;
        const lockedUntil = nextFailed >= ACCOUNT_FAILURE_THRESHOLD
          ? new Date(Date.now() + ACCOUNT_LOCK_SECONDS * 1000)
          : null;
        await db
          .update(userCredentials)
          .set({ failedAttempts: nextFailed, lockedUntil, updatedAt: new Date() })
          .where(eq(userCredentials.userId, row.userId));
        const ipLocked = await recordIpFailureAndCheckLocked(config, meta.ip);
        await logEvent(db, config, row.userId, "login_failure", meta, { email, reason: "bad_password" });
        if (ipLocked) {
          return reply
            .code(429)
            .send(authErrorResponse(AuthErrorCode.AUTH_RATE_LIMITED, "Too many attempts. Try again later.", 429));
        }
        return genericInvalid();
      }

      if (row.status !== "active" || row.isBlocked) {
        await logEvent(db, config, row.userId, "login_failure", meta, { email, reason: "account_blocked" });
        return reply
          .code(403)
          .send(authErrorResponse(AuthErrorCode.AUTH_ACCOUNT_BLOCKED, "Account is inactive or blocked", 403));
      }

      if (verify.needsRehash) {
        const rehash = await hashPassword(parsed.data.password);
        await db
          .update(userCredentials)
          .set({
            passwordHash: rehash.hash,
            hashAlgo: rehash.algo,
            hashParams: rehash.params,
            passwordUpdatedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(userCredentials.userId, row.userId));
      }

      await db
        .update(userCredentials)
        .set({ failedAttempts: 0, lockedUntil: null, updatedAt: new Date() })
        .where(eq(userCredentials.userId, row.userId));
      await clearIpFailures(config, meta.ip);

      const session = await createSession(db, config, row.userId, meta);
      const accessToken = await signAccessToken({ sub: row.userId, sid: session.sessionId }, config);
      setAuthCookies(reply, config, session.refreshToken);
      await logEvent(db, config, row.userId, "login_success", meta, { email, sessionId: session.sessionId });

      return reply.send(successResponse({ accessToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS }));
    }
  );

  // --- POST /auth/refresh ---------------------------------------------------------------
  app.post(
    "/auth/refresh",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!requireEnabled(reply)) return;
      const config = app.config;
      const db = app.db;
      if (!db) return reply.code(503).send(errorResponse("Database unavailable", 503));

      if (!checkCsrf(request)) {
        return reply.code(403).send(errorResponse("Missing or invalid CSRF token", 403));
      }

      const rawToken = request.cookies?.[REFRESH_COOKIE_NAME];
      if (!rawToken) {
        return reply
          .code(401)
          .send(authErrorResponse(AuthErrorCode.AUTH_MISSING_TOKEN, "Missing refresh cookie", 401));
      }

      try {
        const rotated = await rotateRefreshTokenChecked(db, config, rawToken, requestMeta(request));
        const accessToken = await signAccessToken(
          { sub: rotated.userId, sid: rotated.sessionId },
          config
        );
        setAuthCookies(reply, config, rotated.refreshToken);
        return reply.send(successResponse({ accessToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS }));
      } catch (err) {
        if (err instanceof HttpError) {
          clearAuthCookies(reply, config);
          if (err.statusCode === 409) {
            return reply
              .code(409)
              .send(errorResponse(err.message, 409));
          }
          return sendAuthHttpError(reply, err);
        }
        throw err;
      }
    }
  );

  // --- POST /auth/logout -----------------------------------------------------------------
  app.post("/auth/logout", async (request, reply) => {
    if (!requireEnabled(reply)) return;
    const config = app.config;
    const db = app.db;
    if (!db) return reply.code(503).send(errorResponse("Database unavailable", 503));

    if (!checkCsrf(request)) {
      return reply.code(403).send(errorResponse("Missing or invalid CSRF token", 403));
    }

    const rawToken = request.cookies?.[REFRESH_COOKIE_NAME];
    if (rawToken) {
      const sessionId = await findSessionIdForRawToken(db, config, rawToken);
      if (sessionId) {
        await revokeSession(db, config, sessionId, "logout", requestMeta(request));
      }
    }
    clearAuthCookies(reply, config);
    return reply.code(204).send();
  });

  // --- POST /auth/logout-all --------------------------------------------------------------
  app.post("/auth/logout-all", async (request, reply) => {
    if (!requireEnabled(reply)) return;
    const config = app.config;
    const db = app.db;
    if (!db) return reply.code(503).send(errorResponse("Database unavailable", 503));

    try {
      const identity = await requireOwnAuthUser(request, app);
      await revokeAllSessionsForUser(db, config, identity.userId, "logout_all", requestMeta(request));
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof HttpError) return sendAuthHttpError(reply, err);
      throw err;
    }
  });

  // --- GET /auth/me ------------------------------------------------------------------------
  app.get("/auth/me", async (request, reply) => {
    if (!requireEnabled(reply)) return;
    try {
      const identity = await requireOwnAuthUser(request, app);
      return reply.send(
        successResponse({
          userId: identity.userId,
          email: identity.email,
          fullName: identity.fullName,
          workspaceId: identity.workspaceId,
          role: identity.role,
        })
      );
    } catch (err) {
      if (err instanceof HttpError) return sendAuthHttpError(reply, err);
      throw err;
    }
  });
}

/** Looks up which session a raw refresh-token cookie value belongs to, without rotating it —
 *  used only by logout, which revokes but must never itself consume/rotate the token. Mirrors
 *  session.service.ts's own token-hash lookup rather than exporting an internal helper from
 *  there for one call site. */
async function findSessionIdForRawToken(
  db: Db,
  config: Env,
  rawToken: string
): Promise<string | null> {
  if (!config.AUTH_REFRESH_TOKEN_PEPPER) return null;
  const tokenHash = createHmac("sha256", config.AUTH_REFRESH_TOKEN_PEPPER).update(rawToken).digest("hex");
  const [row] = await db
    .select({ sessionId: authRefreshTokens.sessionId })
    .from(authRefreshTokens)
    .where(eq(authRefreshTokens.tokenHash, tokenHash))
    .limit(1);
  return row?.sessionId ?? null;
}

/** Thin wrapper around session.service's rotateRefreshToken that also resolves the owning
 *  user id (rotateRefreshToken only knows about sessions, not users) for the new access token's
 *  `sub` claim. */
async function rotateRefreshTokenChecked(
  db: Db,
  config: Env,
  rawToken: string,
  meta: ReturnType<typeof requestMeta>
): Promise<{ userId: string; sessionId: string; refreshToken: string }> {
  const rotated = await rotateRefreshToken(db, config, rawToken, meta);
  const [session] = await db
    .select({ userId: schema.authSessions.userId })
    .from(schema.authSessions)
    .where(eq(schema.authSessions.id, rotated.sessionId))
    .limit(1);
  if (!session) throw new HttpError(AuthErrorCode.AUTH_TOKEN_INVALID, 401);
  return { userId: session.userId, sessionId: rotated.sessionId, refreshToken: rotated.refreshToken };
}
