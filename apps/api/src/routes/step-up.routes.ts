import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { schema } from "@skout/db";
import {
  AuthErrorCode,
  AuthErrorMessage,
  AuthTokenInvalidError,
  authErrorResponse,
  authRuntimeFlags,
  issueStepUpToken,
  resolveAuth,
  resolveAuthErrorCode,
  resolveOrProvisionUser,
} from "@skout/auth";
import { buildApiResolveAuthConfig } from "../plugins/auth-resolve-config.js";
import { errorResponse } from "../utils/http.js";
import {
  hashPassword,
  verifyPassword,
  verifyUnknownUser,
} from "../services/credential.service.js";
import {
  ACCOUNT_FAILURE_THRESHOLD,
  ACCOUNT_LOCK_SECONDS,
  clearIpFailures,
  isIpLocked,
  recordIpFailureAndCheckLocked,
} from "../services/auth-lockout.service.js";
import { logEvent } from "../services/session.service.js";

const { users, userCredentials } = schema;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function requestMeta(request: FastifyRequest) {
  return { ip: request.ip, userAgent: request.headers["user-agent"] as string | undefined };
}

const bodySchema = z
  .object({
    /**
     * A fresh Clerk session/JWT — the frontend re-prompts the user (password/MFA, per Clerk's own
     * re-authentication UI) and posts the resulting token here. This is deliberately re-verified
     * independently of the long-lived session already on this request, since the whole point of
     * step-up is proving the user *just* re-authenticated, not that they're still logged in.
     */
    clerkToken: z.string().min(1).optional(),
    /**
     * Password re-authentication for own-auth users (AUTH-BE-27). Re-prompts the user for their
     * password and verifies against user_credentials with lockout counting (BE-14).
     */
    password: z.string().min(1).optional(),
    /**
     * Optional email to verify that re-auth is for the expected identity. If provided and it does
     * not match the session user, returns 403 AUTH_REAUTH_USER_MISMATCH.
     */
    email: z.string().email().optional(),
  })
  .refine((data) => Boolean(data.clerkToken || data.password), {
    message: "Either clerkToken or password must be provided",
  });

/**
 * §11.1 (Enterprise Completion Plan) — Task 16: the real issuer for @skout/auth's
 * assertStepUp() control, using the same `resolveAuth` path as apps/api's auth plugin
 * (plugins/auth.ts) for the primary session. Independently verifies the posted
 * Clerk token or native password credential, confirms it resolves to the *same* internal
 * user already authenticated on this request (not just any valid credential — see the userId
 * match check below, which is what stops a credential for a different account from stepping up
 * this session), then issues a signed, short-lived x-reauth-token (packages/auth/src/step-up.ts).
 *
 * AUTH-BE-27: Accepts re-authentication by password for own-auth users, while still accepting
 * clerkToken for Clerk users during dual-verify. Wrong attempts count toward the same lockout
 * as login (BE-14).
 */
export async function stepUpRoutes(app: FastifyInstance) {
  app.post(
    "/auth/step-up",
    { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!request.userId) {
        return reply
          .code(401)
          .send(authErrorResponse(AuthErrorCode.AUTH_UNAUTHORIZED, AuthErrorMessage.UNAUTHORIZED, 401));
      }

      const config = app.config;
      if (!config.STEP_UP_SIGNING_SECRET) {
        return reply.code(503).send(errorResponse("Step-up re-authentication is not configured", 503));
      }

      const parsed = bodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send(errorResponse("Invalid step-up payload", 400, parsed.error.flatten()));
      }

      if (!app.db) return reply.code(503).send(errorResponse("Database unavailable", 503));
      const db = app.db;

      if (parsed.data.password) {
        const meta = requestMeta(request);

        if (await isIpLocked(config, meta.ip)) {
          await logEvent(db, config, request.userId, "step_up_failure", meta, { reason: "ip_rate_limited" });
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
          .leftJoin(userCredentials, eq(userCredentials.userId, users.id))
          .where(eq(users.id, request.userId))
          .limit(1);

        if (parsed.data.email && row && normalizeEmail(parsed.data.email) !== normalizeEmail(row.email)) {
          await logEvent(db, config, request.userId, "step_up_failure", meta, {
            reason: "user_mismatch",
            providedEmail: parsed.data.email,
          });
          return reply
            .code(403)
            .send(
              authErrorResponse(
                AuthErrorCode.AUTH_REAUTH_USER_MISMATCH,
                AuthErrorMessage.REAUTH_USER_MISMATCH,
                403
              )
            );
        }

        if (!row || !row.passwordHash || !row.hashAlgo) {
          await verifyUnknownUser(parsed.data.password);
          const ipLocked = await recordIpFailureAndCheckLocked(config, meta.ip);
          await logEvent(db, config, request.userId, "step_up_failure", meta, { reason: "no_password_credential" });
          if (ipLocked) {
            return reply
              .code(429)
              .send(authErrorResponse(AuthErrorCode.AUTH_RATE_LIMITED, "Too many attempts. Try again later.", 429));
          }
          return reply
            .code(401)
            .send(authErrorResponse(AuthErrorCode.AUTH_INVALID_CREDENTIALS, "Invalid credentials.", 401));
        }

        if (row.lockedUntil && row.lockedUntil.getTime() > Date.now()) {
          await logEvent(db, config, row.userId, "step_up_failure", meta, { reason: "account_locked" });
          return reply
            .code(429)
            .send(authErrorResponse(AuthErrorCode.AUTH_RATE_LIMITED, "Too many attempts. Try again later.", 429));
        }

        if (row.status !== "active" || row.isBlocked) {
          await logEvent(db, config, row.userId, "step_up_failure", meta, { reason: "account_blocked" });
          return reply
            .code(403)
            .send(authErrorResponse(AuthErrorCode.AUTH_ACCOUNT_BLOCKED, "Account is inactive or blocked", 403));
        }

        const verify = await verifyPassword(parsed.data.password, {
          passwordHash: row.passwordHash,
          hashAlgo: row.hashAlgo,
          hashParams: row.hashParams,
        });

        if (!verify.valid) {
          const nextFailed = (row.failedAttempts ?? 0) + 1;
          const lockedUntil =
            nextFailed >= ACCOUNT_FAILURE_THRESHOLD
              ? new Date(Date.now() + ACCOUNT_LOCK_SECONDS * 1000)
              : null;
          await db
            .update(userCredentials)
            .set({ failedAttempts: nextFailed, lockedUntil, updatedAt: new Date() })
            .where(eq(userCredentials.userId, row.userId));
          const ipLocked = await recordIpFailureAndCheckLocked(config, meta.ip);
          await logEvent(db, config, row.userId, "step_up_failure", meta, { reason: "bad_password" });
          if (ipLocked) {
            return reply
              .code(429)
              .send(authErrorResponse(AuthErrorCode.AUTH_RATE_LIMITED, "Too many attempts. Try again later.", 429));
          }
          return reply
            .code(401)
            .send(authErrorResponse(AuthErrorCode.AUTH_INVALID_CREDENTIALS, "Invalid credentials.", 401));
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

        await logEvent(db, config, row.userId, "step_up_success", meta);

        const issuedAtMs = Date.now();
        const reauthToken = issueStepUpToken(config.STEP_UP_SIGNING_SECRET, request.userId, issuedAtMs);
        return reply.send({
          data: {
            reauthToken,
            issuedAt: new Date(issuedAtMs).toISOString(),
            expiresInMinutes: 15,
          },
        });
      }

      // Clerk branch (parsed.data.clerkToken is guaranteed since refine required one of password or clerkToken)
      const authRuntime = authRuntimeFlags({ ...config, appRole: "api" });
      if (authRuntime.AUTH_USE_STUB || !authRuntime.AUTH_USE_CLERK_JWT) {
        return reply
          .code(501)
          .send(errorResponse("Step-up re-authentication requires Clerk auth to be active", 501));
      }

      const clerkJwtIssuer = config.CLERK_JWT_ISSUER;
      if (!clerkJwtIssuer) {
        return reply.code(503).send(errorResponse("CLERK_JWT_ISSUER is not configured", 503));
      }

      let identity;
      try {
        identity = await resolveAuth(parsed.data.clerkToken!, buildApiResolveAuthConfig(config));
      } catch (err) {
        app.log.warn({ err }, "Step-up Clerk token verification failed");
        if (err instanceof AuthTokenInvalidError) {
          const code = resolveAuthErrorCode(err);
          return reply.code(401).send(authErrorResponse(code, err.message, 401));
        }
        return reply
          .code(401)
          .send(
            authErrorResponse(
              AuthErrorCode.AUTH_TOKEN_INVALID,
              AuthErrorMessage.STEP_UP_CLERK_INVALID,
              401
            )
          );
      }

      const result = await resolveOrProvisionUser(db, identity);
      if (result.userId !== request.userId) {
        return reply
          .code(403)
          .send(
            authErrorResponse(
              AuthErrorCode.AUTH_REAUTH_USER_MISMATCH,
              AuthErrorMessage.REAUTH_USER_MISMATCH,
              403
            )
          );
      }

      const issuedAtMs = Date.now();
      const reauthToken = issueStepUpToken(config.STEP_UP_SIGNING_SECRET, result.userId, issuedAtMs);
      return reply.send({
        data: {
          reauthToken,
          issuedAt: new Date(issuedAtMs).toISOString(),
          expiresInMinutes: 15,
        },
      });
    }
  );
}
