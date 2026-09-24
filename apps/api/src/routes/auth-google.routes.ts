/**
 * AUTH-BE-16 — Google sign-in backend routes (OAuth 2.0 code flow + PKCE).
 *
 * Behind AUTH_CUSTOM_ENABLED (default off).
 * Endpoints:
 * - GET  /auth/google/start
 * - POST /auth/google/callback
 *
 * Ground Rule 5: Never auto-link an account by email unless the provider reports the email as verified.
 * Blocked / inactive users are refused with 403 AUTH_ACCOUNT_BLOCKED.
 * Successful callback issues a normal own-auth session with refresh cookie (BE-14).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { schema } from "@skout/db";
import { AuthErrorCode, authErrorResponse, resolveOrProvisionUser } from "@skout/auth";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { errorResponse, successResponse } from "../utils/http.js";
import { logEvent } from "../services/session.service.js";
import { issueOwnAuthSession } from "./auth-core.routes.js";
import {
  GOOGLE_STATE_COOKIE_NAME,
  GOOGLE_STATE_TTL_SECONDS,
  buildGoogleAuthorizationUrl,
  createGoogleOAuthState,
  exchangeGoogleCode,
  generateNonce,
  generatePkcePair,
  getGoogleOAuthCredentials,
  validateSafeNextUrl,
  verifyAndConsumeGoogleOAuthState,
  verifyGoogleIdToken,
} from "../services/google-auth.service.js";

const log = createLogger("auth-google.routes");
const { users } = schema;

const callbackBodySchema = z.object({
  code: z.string().trim().min(1, "Authorization code is required"),
  state: z.string().trim().min(1, "OAuth state is required"),
});

const startQuerySchema = z.object({
  next: z.string().optional(),
  redirect: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
});

function requestMeta(request: FastifyRequest) {
  return { ip: request.ip, userAgent: request.headers["user-agent"] as string | undefined };
}

function stateCookieOptions(config: Env) {
  return {
    httpOnly: true,
    secure: config.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/api/v1/auth",
    maxAge: GOOGLE_STATE_TTL_SECONDS,
  };
}

export async function authGoogleRoutes(app: FastifyInstance) {
  function requireEnabled(reply: FastifyReply): boolean {
    if (!app.config.AUTH_CUSTOM_ENABLED) {
      reply.code(404).send(errorResponse("Not found", 404));
      return false;
    }
    return true;
  }

  // --- GET /auth/google/start -----------------------------------------------------------
  app.get(
    "/auth/google/start",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!requireEnabled(reply)) return;
      const config = app.config;

      try {
        getGoogleOAuthCredentials(config);
      } catch (err: unknown) {
        return reply.code(503).send(errorResponse("Google sign-in is not configured", 503));
      }

      const queryParsed = startQuerySchema.safeParse(request.query ?? {});
      const nextParam = queryParsed.success ? queryParsed.data.next : undefined;
      const shouldRedirect = queryParsed.success ? queryParsed.data.redirect : false;

      const safeNext = validateSafeNextUrl(nextParam);
      const pkce = generatePkcePair();
      const nonce = generateNonce();

      const { stateId, signedState } = await createGoogleOAuthState(config, {
        verifier: pkce.verifier,
        nonce,
        next: safeNext,
      });

      // Bind to browser session via HttpOnly cookie
      reply.setCookie(GOOGLE_STATE_COOKIE_NAME, stateId, stateCookieOptions(config));

      const authorizationUrl = buildGoogleAuthorizationUrl(config, {
        state: signedState,
        challenge: pkce.challenge,
        nonce,
      });

      const meta = requestMeta(request);
      if (app.db) {
        await logEvent(app.db, config, null, "oauth_start", meta, {
          provider: "google",
          next: safeNext,
        }).catch(() => undefined);
      }

      // If requested or called directly via browser navigation
      if (shouldRedirect || request.headers.accept?.includes("text/html")) {
        return reply.redirect(authorizationUrl);
      }

      return reply.send(successResponse({ authorizationUrl, state: signedState }));
    }
  );

  // --- POST /auth/google/callback -------------------------------------------------------
  app.post(
    "/auth/google/callback",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!requireEnabled(reply)) return;
      const config = app.config;
      const db = app.db;
      if (!db) return reply.code(503).send(errorResponse("Database unavailable", 503));

      try {
        getGoogleOAuthCredentials(config);
      } catch (err: unknown) {
        return reply.code(503).send(errorResponse("Google sign-in is not configured", 503));
      }

      const parsed = callbackBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send(errorResponse("Invalid callback payload", 400, parsed.error.flatten()));
      }

      const cookieStateId = request.cookies?.[GOOGLE_STATE_COOKIE_NAME];
      // Immediately clear the state cookie
      reply.clearCookie(GOOGLE_STATE_COOKIE_NAME, { path: "/api/v1/auth" });

      const stateData = await verifyAndConsumeGoogleOAuthState(config, parsed.data.state, cookieStateId);
      if (!stateData) {
        return reply
          .code(401)
          .send(authErrorResponse(AuthErrorCode.AUTH_TOKEN_INVALID, "Invalid, expired, or replayed OAuth state.", 401));
      }

      const meta = requestMeta(request);

      let tokenResponse;
      try {
        tokenResponse = await exchangeGoogleCode(config, parsed.data.code, stateData.verifier);
      } catch (err) {
        await logEvent(db, config, null, "oauth_failure", meta, {
          provider: "google",
          reason: "token_exchange_failed",
        }).catch(() => undefined);
        return reply
          .code(401)
          .send(authErrorResponse(AuthErrorCode.AUTH_TOKEN_INVALID, "Failed to exchange code with Google.", 401));
      }

      let googleUser;
      try {
        googleUser = await verifyGoogleIdToken(config, tokenResponse.id_token, stateData.nonce);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Failed to verify Google token";
        const isEmailNotVerified = message.includes("email is not verified");
        const code = isEmailNotVerified
          ? AuthErrorCode.AUTH_EMAIL_NOT_VERIFIED
          : AuthErrorCode.AUTH_TOKEN_INVALID;
        const status = isEmailNotVerified ? 403 : 401;

        await logEvent(db, config, null, "oauth_failure", meta, {
          provider: "google",
          reason: message,
        }).catch(() => undefined);

        return reply.code(status).send(authErrorResponse(code, message, status));
      }

      // Check if user is blocked or inactive before provisioning/linking
      const [existingUser] = await db
        .select({ id: users.id, status: users.status, isBlocked: users.isBlocked })
        .from(users)
        .where(eq(users.email, googleUser.email))
        .limit(1);

      if (existingUser && (existingUser.status !== "active" || existingUser.isBlocked)) {
        await logEvent(db, config, existingUser.id, "oauth_failure", meta, {
          provider: "google",
          reason: "account_blocked",
        }).catch(() => undefined);
        return reply
          .code(403)
          .send(authErrorResponse(AuthErrorCode.AUTH_ACCOUNT_BLOCKED, "Account is inactive or blocked", 403));
      }

      let provisionResult;
      try {
        provisionResult = await resolveOrProvisionUser(db, {
          provider: "google",
          subject: googleUser.sub,
          email: googleUser.email,
          emailVerified: true,
          name: googleUser.name,
        });
      } catch (err: unknown) {
        log.error("auth-google.routes: resolveOrProvisionUser failed", err);
        return reply.code(500).send(errorResponse("Failed to provision or link user", 500));
      }

      // Issue own-auth session and set cookies (skout_refresh, skout_csrf)
      const session = await issueOwnAuthSession(db, config, reply, provisionResult.userId, meta);

      await logEvent(db, config, provisionResult.userId, "oauth_success", meta, {
        provider: "google",
        email: googleUser.email,
        sessionId: session.sessionId,
      });

      return reply.send(
        successResponse({
          accessToken: session.accessToken,
          expiresIn: session.expiresIn,
          next: stateData.next,
          user: {
            id: provisionResult.userId,
            email: provisionResult.userEmail,
            role: provisionResult.role,
            workspaceId: provisionResult.workspaceId,
          },
        })
      );
    }
  );
}
