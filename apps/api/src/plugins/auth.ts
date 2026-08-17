import type { FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { and, eq, gt } from "drizzle-orm";
import { timingSafeEqual } from "node:crypto";
import { schema } from "@skout/db";
import { resolveOrProvisionUser } from "../services/auth.service.js";
import { errorResponse, HttpError } from "../utils/http.js";

/** Constant-time string compare so secret checks don't leak timing info. */
function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still run a compare against a same-length buffer to avoid a length-based timing signal.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
    userEmail?: string;
    workspaceId?: string;
    role?: string;
  }
}

function isEmailIntelExternalRoute(url: string): boolean {
  return url.split("?")[0]!.startsWith("/api/v1/email-intel/");
}

function isHealthRoute(url: string): boolean {
  return url === "/api/v1/health" || url.startsWith("/health");
}

function emailIntelApiKeyFromRequest(request: FastifyRequest): string {
  const header = request.headers["x-api-key"];
  if (typeof header === "string" && header.trim()) return header.trim();
  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    return authorization.slice(7).trim();
  }
  return "";
}

function acceptEmailIntelApiKey(request: FastifyRequest, secret: string | undefined): boolean {
  if (!secret || !isEmailIntelExternalRoute(request.url)) return false;
  const provided = emailIntelApiKeyFromRequest(request);
  return Boolean(provided) && timingSafeEqualStrings(provided, secret);
}

function isPublicRoute(url: string, method?: string): boolean {
  // Only GET /api/v1/team/invites/<token> is public; DELETE and /accept suffix require auth
  const isInviteTokenLookup =
    method === "GET" &&
    /^\/api\/v1\/team\/invites\/[^/]+$/.test(url.split("?")[0]!);
  return (
    url.startsWith("/api/v1/crm/hubspot/callback") ||
    url.startsWith("/api/v1/billing/webhooks/") ||
    url.startsWith("/api/v1/webhooks/unipile/") ||
    url.startsWith("/api/v1/track/") ||
    url.startsWith("/api/v1/unsubscribe/") ||
    url.startsWith("/api/v1/invite-auth/send-otp") ||
    url.startsWith("/api/v1/invite-auth/verify-otp") ||
    // OAuth callbacks — Google/Microsoft redirect the browser here directly after consent, a
    // top-level navigation that can never carry our Authorization header. These were never
    // reachable without this: the global auth hook 401'd them with "Missing bearer token"
    // before the handler below got a chance to run. Each handler independently verifies the
    // signed `state` param (verifyOAuthState, same HMAC pattern as the already-public HubSpot
    // callback above) — that's the real auth here, not this header.
    url.startsWith("/api/v1/calendar/connect/google/callback") ||
    url.startsWith("/api/v1/inboxes/connect/google/callback") ||
    url.startsWith("/api/v1/inboxes/connect/microsoft/callback") ||
    // R20.2 — Twilio calls these directly; not signature-verified yet (see dependency doc).
    url.startsWith("/api/v1/calls/twiml/") ||
    url.startsWith("/api/v1/calls/status") ||
    url.startsWith("/api/v1/calls/recording-status") ||
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
      if (acceptEmailIntelApiKey(request, config.EMAIL_INTEL_EXTERNAL_API_KEY)) {
        request.userId = "email-intel-external";
        request.userEmail = "n8n@skoutai.internal";
        request.workspaceId = "external-email-intel";
        request.role = "integration";
        return;
      }
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
    if (isHealthRoute(request.url) || isPublicRoute(request.url, request.method)) {
      return;
    }
    if (acceptEmailIntelApiKey(request, config.EMAIL_INTEL_EXTERNAL_API_KEY)) {
      request.userId = "email-intel-external";
      request.userEmail = "n8n@skoutai.internal";
      request.workspaceId = "external-email-intel";
      request.role = "integration";
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

    // Static-secret admin import auth (/admin/import page in the frontend). Deliberately
    // scoped to import routes only — a leaked ADMIN_IMPORT_SECRET can seed data, nothing else.
    if (token.startsWith("admin_")) {
      const isImportRoute = request.url.split("?")[0]!.startsWith("/api/v1/import/");
      const secret = config.ADMIN_IMPORT_SECRET;
      const targetWorkspaceId = config.ADMIN_IMPORT_WORKSPACE_ID;
      if (!isImportRoute || !secret || !targetWorkspaceId) {
        return reply.code(401).send(errorResponse("Invalid authorization token", 401));
      }
      const provided = token.slice("admin_".length);
      if (!timingSafeEqualStrings(provided, secret)) {
        return reply.code(401).send(errorResponse("Invalid authorization token", 401));
      }
      request.userId = "admin-import";
      request.userEmail = "admin-import@skoutai.internal";
      request.workspaceId = targetWorkspaceId;
      request.role = "admin";
      return;
    }

    // Invite session token (issued after OTP verification)
    if (token.startsWith("isk_")) {
      const [session] = await db
        .select({ userId: schema.inviteSessions.userId })
        .from(schema.inviteSessions)
        .where(
          and(
            eq(schema.inviteSessions.token, token),
            gt(schema.inviteSessions.expiresAt, new Date())
          )
        )
        .limit(1);

      if (!session) {
        return reply.code(401).send(errorResponse("Session expired or invalid", 401));
      }

      const [user] = await db
        .select({ email: schema.users.email })
        .from(schema.users)
        .where(eq(schema.users.id, session.userId))
        .limit(1);

      const [membership] = await db
        .select({ workspaceId: schema.workspaceMembers.workspaceId, role: schema.workspaceMembers.role })
        .from(schema.workspaceMembers)
        .where(eq(schema.workspaceMembers.userId, session.userId))
        .limit(1);

      request.userId = session.userId;
      request.userEmail = user?.email;
      request.workspaceId = membership?.workspaceId;
      request.role = membership?.role;
      return;
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
