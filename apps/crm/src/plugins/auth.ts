import type { FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import {
  AuthErrorCode,
  AuthErrorMessage,
  AuthTokenInvalidError,
  authErrorResponse,
  buildClerkAppResolveAuthConfig,
  resolveAuth,
  resolveAuthErrorCode,
  resolveOrProvisionUser,
} from "@skout/auth";
import { errorResponse, HttpError } from "../utils/http.js";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
    userEmail?: string;
    workspaceId?: string;
    role?: string;
  }
}

function isHealthRoute(url: string): boolean {
  const pathname = url.split("?")[0];
  return pathname === "/api/v1/crm/health" || pathname.startsWith("/health");
}

/**
 * R16.2 — meeting-bot vendor calls this directly; verified via `?secret=`, not a Clerk JWT.
 * Phase 3 — inbound RSVP webhook; verified via HMAC signature (x-rsvp-signature), not a Clerk
 * JWT — the caller is an unauthenticated external mail forwarder, not a logged-in user.
 * §5/§7.1 — internal service routes use X-Internal-Service-Token instead of Clerk.
 */
function isPublicRoute(url: string): boolean {
  const pathname = url.split("?")[0] ?? "";
  return (
    pathname === "/api/v1/meetings/webhook" ||
    pathname === "/api/v1/webhooks/meeting-rsvp" ||
    pathname.startsWith("/internal/v1/")
  );
}

/**
 * AUTH-BE-05 — Clerk JWTs use `@skout/auth` `resolveAuth` and shared `computeAuthorizedParties`
 * (via `buildClerkAppResolveAuthConfig`). Public/vendor/internal paths are allowlisted below.
 *
 * Product note: unlike `apps/api`, this plugin does **not** accept `admin_` or `isk_` bearer
 * tokens today (invite-session users cannot call CRM). Adding `isk_` parity is a product
 * decision — confirm with Aditya before implementing (AUTH-BE-05).
 */
export const authPlugin = fp(async (app) => {
  const config = app.config;

  const clerkKeyInvalid =
    !config.CLERK_SECRET_KEY ||
    config.CLERK_SECRET_KEY.trim().toLowerCase() === "replace-me";

  if (config.NODE_ENV === "production" && (config.AUTH_STUB || clerkKeyInvalid)) {
    throw new Error("Production requires CLERK_SECRET_KEY and AUTH_STUB must be false");
  }

  const useStubAuth = clerkKeyInvalid || config.AUTH_STUB;

  if (useStubAuth) {
    app.log.warn(
      config.AUTH_STUB
        ? "AUTH_STUB=true — JWT disabled, using stub user"
        : "CLERK_SECRET_KEY not set — running in stub mode"
    );
    app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
      if (request.method === "OPTIONS") return;
      if (isHealthRoute(request.url) || isPublicRoute(request.url)) return;
      const stubEmail =
        (request.headers["x-stub-user-email"] as string | undefined) ?? "stub@example.com";
      const db = app.db;
      if (!db) {
        return reply.code(500).send(errorResponse("Database not available", 500));
      }
      try {
        const result = await resolveOrProvisionUser(db, `stub:${stubEmail}`, stubEmail, "Stub User");
        request.userId = result.userId;
        request.userEmail = result.userEmail;
        request.workspaceId = result.workspaceId;
        request.role = result.role;
      } catch (err) {
        app.log.error({ err }, "Stub user provisioning failed");
        return reply.code(500).send(errorResponse("Stub user provisioning failed", 500));
      }
    });
    return;
  }

  const resolveAuthConfig = buildClerkAppResolveAuthConfig({
    clerkSecretKey: config.CLERK_SECRET_KEY!,
    clerkJwtIssuer: config.CLERK_JWT_ISSUER,
    corsOrigin: config.CORS_ORIGIN,
    frontendUrl: config.FRONTEND_URL,
  });

  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.method === "OPTIONS") return;
    if (isHealthRoute(request.url) || isPublicRoute(request.url)) return;

    const db = app.db;
    if (!db) {
      return reply.code(500).send(errorResponse("Database not available", 500));
    }

    const authorization = request.headers.authorization;
    const token =
      typeof authorization === "string" && authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : undefined;

    if (!token) {
      return reply
        .code(401)
        .send(authErrorResponse(AuthErrorCode.AUTH_MISSING_TOKEN, AuthErrorMessage.MISSING_BEARER, 401));
    }

    try {
      const identity = await resolveAuth(token, resolveAuthConfig);
      const result = await resolveOrProvisionUser(db, identity);

      request.userId = result.userId;
      request.userEmail = result.userEmail;
      request.workspaceId = result.workspaceId;
      request.role = result.role;
    } catch (error) {
      app.log.error({ err: error }, "Auth failed");
      if (error instanceof AuthTokenInvalidError) {
        const code = resolveAuthErrorCode(error);
        return reply.code(401).send(authErrorResponse(code, error.message, 401));
      }
      if (error instanceof HttpError) {
        const code = resolveAuthErrorCode(error);
        return reply.code(error.statusCode).send(authErrorResponse(code, error.message, error.statusCode));
      }
      const isDbError =
        typeof error === "object" &&
        error !== null &&
        ("query" in error || (error as { code?: string }).code === "ECONNREFUSED");
      if (isDbError) {
        return reply.code(500).send(errorResponse("User provisioning failed", 500));
      }
      const message = error instanceof Error ? error.message : AuthErrorMessage.INVALID_AUTHORIZATION;
      const code = resolveAuthErrorCode(error, message);
      return reply.code(401).send(authErrorResponse(code, message, 401));
    }
  });
});
