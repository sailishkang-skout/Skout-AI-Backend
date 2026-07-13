import type { FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { resolveOrProvisionUser } from "../services/auth.service.js";
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
  return url === "/api/v1/health" || url.startsWith("/health");
}

function isPublicRoute(url: string, method?: string): boolean {
  // Only GET /api/v1/team/invites/<token> is public; DELETE and /accept suffix require auth
  const isInviteTokenLookup =
    method === "GET" &&
    /^\/api\/v1\/team\/invites\/[^/]+$/.test(url.split("?")[0]!);
  return (
    url.startsWith("/api/v1/crm/hubspot/callback") ||
    url.startsWith("/api/v1/billing/webhooks/") ||
    url.startsWith("/api/v1/track/") ||
    url.startsWith("/api/v1/unsubscribe/") ||
    isInviteTokenLookup
  );
}

function normalizeOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    url.hostname = url.hostname.toLowerCase();
    return url.origin;
  } catch {
    return origin.toLowerCase();
  }
}

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
      // CORS preflight (and any OPTIONS) must never require auth.
      if (request.method === "OPTIONS") return;
      if (isHealthRoute(request.url) || isPublicRoute(request.url, request.method)) return;
      const stubEmail = (request.headers["x-stub-user-email"] as string | undefined) ?? config.AUTH_STUB_EMAIL ?? "stub@example.com";
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

  const authorizedParties = [
    ...config.CORS_ORIGIN.map(normalizeOrigin),
    ...(config.FRONTEND_URL ? [normalizeOrigin(config.FRONTEND_URL)] : []),
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ].filter((value, index, all) => all.indexOf(value) === index);

  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    // CORS preflight (and any OPTIONS) must never require auth.
    if (request.method === "OPTIONS") {
      return;
    }
    if (isHealthRoute(request.url) || isPublicRoute(request.url)) {
      return;
    }

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
      return reply.code(401).send(errorResponse("Missing bearer token", 401));
    }

    try {
      const { verifyToken } = await import("@clerk/backend");
      const claims = await verifyToken(token, {
        secretKey: config.CLERK_SECRET_KEY,
        authorizedParties,
      });

      const clerkUserId = claims?.sub;
      if (!clerkUserId) {
        return reply.code(401).send(errorResponse("Invalid Clerk token", 401));
      }

      const email = String(claims.email ?? `${clerkUserId}@clerk.local`);
      const fullName = String(claims.name ?? claims.first_name ?? email);

      const result = await resolveOrProvisionUser(db, clerkUserId, email, fullName);

      request.userId = result.userId;
      request.userEmail = result.userEmail;
      request.workspaceId = result.workspaceId;
      request.role = result.role;
    } catch (error) {
      app.log.error({ err: error }, "Auth failed");
      if (error instanceof HttpError) {
        return reply.code(error.statusCode).send(errorResponse(error.message, error.statusCode));
      }
      // DB errors during provisioning are server failures, not invalid tokens.
      const isDbError =
        typeof error === "object" &&
        error !== null &&
        ("query" in error || (error as { code?: string }).code === "ECONNREFUSED");
      if (isDbError) {
        return reply.code(500).send(errorResponse("User provisioning failed", 500));
      }
      const message = error instanceof Error ? error.message : "Invalid authorization token";
      return reply.code(401).send(errorResponse(message, 401));
    }
  });
});
