/**
 * AUTH-BE-16 (Microsoft, ADR-0007 D7) — Microsoft sign-in backend routes (OAuth 2.0 code flow +
 * PKCE). Same shape as auth-google.routes.ts so FE-10 can drive both the same way.
 *
 * Behind AUTH_CUSTOM_ENABLED (default off).
 * Endpoints:
 * - GET  /auth/microsoft/start
 * - POST /auth/microsoft/callback
 *
 * Ground Rule 5: the email is only trusted when Microsoft marks it verified (xms_edov) — see
 * microsoft-auth.service.ts. Blocked / inactive users are refused with 403 AUTH_ACCOUNT_BLOCKED.
 * A successful callback issues a normal own-auth session with refresh cookie (BE-14).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { eq, sql, type SQL } from "drizzle-orm";
import { schema } from "@skout/db";
import type { Db } from "@skout/db";
import { AuthErrorCode, authErrorResponse, HttpError, resolveOrProvisionUser } from "@skout/auth";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { errorResponse, successResponse } from "../utils/http.js";
import { logEvent } from "../services/session.service.js";
import { issueOwnAuthSession } from "./auth-core.routes.js";
import { generateNonce, generatePkcePair, validateSafeNextUrl } from "../services/google-auth.service.js";
import {
  MICROSOFT_STATE_COOKIE_NAME,
  MICROSOFT_STATE_TTL_SECONDS,
  buildMicrosoftAuthorizationUrl,
  createMicrosoftOAuthState,
  exchangeMicrosoftCode,
  getMicrosoftOAuthCredentials,
  verifyAndConsumeMicrosoftOAuthState,
  verifyMicrosoftIdToken,
} from "../services/microsoft-auth.service.js";

const log = createLogger("auth-microsoft.routes");
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
    maxAge: MICROSOFT_STATE_TTL_SECONDS,
  };
}

async function isBlockedOrInactive(db: Db, where: SQL): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: users.id, status: users.status, isBlocked: users.isBlocked })
    .from(users)
    .where(where)
    .limit(1);
  return row && (row.status !== "active" || row.isBlocked) ? { id: row.id } : null;
}

export async function authMicrosoftRoutes(app: FastifyInstance) {
  function requireEnabled(reply: FastifyReply): boolean {
    if (!app.config.AUTH_CUSTOM_ENABLED) {
      reply.code(404).send(errorResponse("Not found", 404));
      return false;
    }
    return true;
  }

  function requireConfigured(reply: FastifyReply): boolean {
    try {
      getMicrosoftOAuthCredentials(app.config);
      if (!app.config.AUTH_REFRESH_TOKEN_PEPPER && !app.config.INTEGRATION_ENCRYPTION_KEY) {
        throw new HttpError("state signing secret missing", 503);
      }
      return true;
    } catch {
      reply.code(503).send(errorResponse("Microsoft sign-in is not configured", 503));
      return false;
    }
  }

  // --- GET /auth/microsoft/start --------------------------------------------------------
  app.get(
    "/auth/microsoft/start",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!requireEnabled(reply)) return;
      if (!requireConfigured(reply)) return;
      const config = app.config;

      const queryParsed = startQuerySchema.safeParse(request.query ?? {});
      const safeNext = validateSafeNextUrl(queryParsed.success ? queryParsed.data.next : undefined);
      const shouldRedirect = queryParsed.success ? queryParsed.data.redirect : false;

      const pkce = generatePkcePair();
      const nonce = generateNonce();
      const { stateId, signedState } = await createMicrosoftOAuthState(config, {
        verifier: pkce.verifier,
        nonce,
        next: safeNext,
      });

      // Bind to the browser via an HttpOnly cookie; the callback requires it to match.
      reply.setCookie(MICROSOFT_STATE_COOKIE_NAME, stateId, stateCookieOptions(config));

      const authorizationUrl = buildMicrosoftAuthorizationUrl(config, {
        state: signedState,
        challenge: pkce.challenge,
        nonce,
      });

      if (app.db) {
        await logEvent(app.db, config, null, "oauth_start", requestMeta(request), {
          provider: "microsoft",
          next: safeNext,
        }).catch(() => undefined);
      }

      if (shouldRedirect || request.headers.accept?.includes("text/html")) {
        return reply.redirect(authorizationUrl);
      }
      return reply.send(successResponse({ authorizationUrl, state: signedState }));
    }
  );

  // --- POST /auth/microsoft/callback ----------------------------------------------------
  app.post(
    "/auth/microsoft/callback",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!requireEnabled(reply)) return;
      const config = app.config;
      const db = app.db;
      if (!db) return reply.code(503).send(errorResponse("Database unavailable", 503));
      if (!requireConfigured(reply)) return;

      const parsed = callbackBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send(errorResponse("Invalid callback payload", 400, parsed.error.flatten()));
      }

      const cookieStateId = request.cookies?.[MICROSOFT_STATE_COOKIE_NAME];
      reply.clearCookie(MICROSOFT_STATE_COOKIE_NAME, { path: "/api/v1/auth" });

      const stateData = await verifyAndConsumeMicrosoftOAuthState(config, parsed.data.state, cookieStateId);
      if (!stateData) {
        return reply
          .code(401)
          .send(authErrorResponse(AuthErrorCode.AUTH_TOKEN_INVALID, "Invalid, expired, or replayed OAuth state.", 401));
      }

      const meta = requestMeta(request);

      let tokenResponse;
      try {
        tokenResponse = await exchangeMicrosoftCode(config, parsed.data.code, stateData.verifier);
      } catch {
        await logEvent(db, config, null, "oauth_failure", meta, {
          provider: "microsoft",
          reason: "token_exchange_failed",
        }).catch(() => undefined);
        return reply
          .code(401)
          .send(authErrorResponse(AuthErrorCode.AUTH_TOKEN_INVALID, "Failed to exchange code with Microsoft.", 401));
      }

      let msUser;
      try {
        msUser = await verifyMicrosoftIdToken(config, tokenResponse.id_token, stateData.nonce);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Failed to verify Microsoft token";
        const isEmailNotVerified = message.includes("email is not verified");
        const code = isEmailNotVerified ? AuthErrorCode.AUTH_EMAIL_NOT_VERIFIED : AuthErrorCode.AUTH_TOKEN_INVALID;
        const status = isEmailNotVerified ? 403 : 401;
        await logEvent(db, config, null, "oauth_failure", meta, { provider: "microsoft", reason: message }).catch(
          () => undefined
        );
        return reply.code(status).send(authErrorResponse(code, message, status));
      }

      const blockedByEmail = await isBlockedOrInactive(db, sql`lower(${users.email}) = ${msUser.email}`);
      if (blockedByEmail) {
        await logEvent(db, config, blockedByEmail.id, "oauth_failure", meta, {
          provider: "microsoft",
          reason: "account_blocked",
        }).catch(() => undefined);
        return reply
          .code(403)
          .send(authErrorResponse(AuthErrorCode.AUTH_ACCOUNT_BLOCKED, "Account is inactive or blocked", 403));
      }

      let provisionResult;
      try {
        provisionResult = await resolveOrProvisionUser(db, {
          provider: "microsoft",
          subject: msUser.subject,
          email: msUser.email,
          emailVerified: true,
          name: msUser.name,
        });
      } catch (err: unknown) {
        log.error("auth-microsoft.routes: resolveOrProvisionUser failed", err);
        return reply.code(500).send(errorResponse("Failed to provision or link user", 500));
      }

      // The identity may already be linked to a user whose current email differs from the
      // token's — re-check the resolved user itself before issuing a session.
      if (await isBlockedOrInactive(db, eq(users.id, provisionResult.userId))) {
        await logEvent(db, config, provisionResult.userId, "oauth_failure", meta, {
          provider: "microsoft",
          reason: "account_blocked",
        }).catch(() => undefined);
        return reply
          .code(403)
          .send(authErrorResponse(AuthErrorCode.AUTH_ACCOUNT_BLOCKED, "Account is inactive or blocked", 403));
      }

      const session = await issueOwnAuthSession(db, config, reply, provisionResult.userId, meta);

      await logEvent(db, config, provisionResult.userId, "oauth_success", meta, {
        provider: "microsoft",
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
