import type { FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { and, eq, gt } from "drizzle-orm";
import { timingSafeEqual } from "node:crypto";
import { schema } from "@skout/db";
import {
  AuthErrorCode,
  AuthErrorMessage,
  AuthTokenInvalidError,
  authErrorResponse,
  authRuntimeFlags,
  computeAuthorizedParties,
  loadPlatformContext,
  normalizeOrigin,
  resolveAuth,
  resolveAuthErrorCode,
  type PlatformContext,
} from "@skout/auth";
import { buildApiResolveAuthConfig } from "./auth-resolve-config.js";
import { resolveOrProvisionUser } from "../services/auth.service.js";
import { verifyInviteSession } from "../services/invite-auth.service.js";
import { errorResponse, HttpError } from "../utils/http.js";
import type { Env } from "../config/env.js";

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
    /** §7 Wave 2 — tenancy/permissions/entitlements/consent snapshot when authenticated. */
    platformContext?: PlatformContext;
  }
}

function isEmailIntelExternalRoute(url: string): boolean {
  const path = url.split("?")[0]!;
  return (
    path.startsWith("/api/v1/email-intel/") ||
    path === "/api/v1/evidence/ingest/email-intel"
  );
}

function isHealthRoute(url: string): boolean {
  return (
    url === "/api/v1/health" ||
    url === "/api/v1/slo" ||
    url === "/api/v1/metrics" ||
    url.startsWith("/health")
  );
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

function evidenceIngestWorkspaceId(request: FastifyRequest, fallback: string | undefined): string | undefined {
  const header = request.headers["x-skout-workspace-id"];
  if (typeof header === "string" && /^[0-9a-f-]{36}$/i.test(header.trim())) return header.trim();
  return fallback;
}

function applyEmailIntelIdentity(
  request: FastifyRequest,
  config: Env
): boolean {
  if (!acceptEmailIntelApiKey(request, config.EMAIL_INTEL_EXTERNAL_API_KEY)) return false;
  request.userId = "email-intel-external";
  request.userEmail = "n8n@skoutai.internal";
  request.role = "integration";
  const path = request.url.split("?")[0]!;
  if (path === "/api/v1/evidence/ingest/email-intel") {
    const ws = evidenceIngestWorkspaceId(request, config.EVIDENCE_INGEST_DEFAULT_WORKSPACE_ID);
    if (!ws) return false;
    request.workspaceId = ws;
  } else {
    request.workspaceId = "external-email-intel";
  }
  return true;
}

function isPublicRoute(url: string, method?: string): boolean {
  const pathname = url.split("?")[0]!;
  // Only GET /api/v1/team/invites/<token> is public; DELETE and /accept suffix require auth
  const isInviteTokenLookup =
    method === "GET" &&
    /^\/api\/v1\/team\/invites\/[^/]+$/.test(pathname);
  return (
    url.startsWith("/api/v1/crm/hubspot/callback") ||
    url.startsWith("/api/v1/crm/hubspot/webhook") ||
    url.startsWith("/api/v1/billing/webhooks/") ||
    url.startsWith("/api/v1/webhooks/unipile/") ||
    url.startsWith("/api/v1/track/") ||
    url.startsWith("/api/v1/unsubscribe/") ||
    url.startsWith("/api/v1/invite-auth/send-otp") ||
    url.startsWith("/api/v1/invite-auth/verify-otp") ||
    pathname.startsWith("/api/v1/crm/hubspot/callback") ||
    pathname.startsWith("/api/v1/crm/hubspot/webhook") ||
    pathname.startsWith("/api/v1/billing/webhooks/") ||
    pathname.startsWith("/api/v1/webhooks/unipile/") ||
    pathname.startsWith("/api/v1/track/") ||
    pathname.startsWith("/api/v1/unsubscribe/") ||
    pathname.startsWith("/api/v1/invite-auth/send-otp") ||
    pathname.startsWith("/api/v1/invite-auth/verify-otp") ||
    pathname === "/api/v1/invite-auth/set-password" ||
    // AUTH-BE-14 — signup/login/refresh are unauthenticated by definition; logout reads a
    // refresh cookie, not a Bearer token; logout-all/me carry an own-auth *access* token that
    // this plugin's resolveAuth() (Clerk-only until AUTH-BE-19) cannot verify. Each route in
    // auth-core.routes.ts does its own verification — see that file's header comment. Listed
    // individually (not a "/api/v1/auth/" prefix) so /api/v1/auth/step-up, which genuinely
    // needs the Clerk-authenticated request.userId this plugin sets, stays protected.
    url === "/api/v1/auth/signup" ||
    url === "/api/v1/auth/login" ||
    url === "/api/v1/auth/refresh" ||
    url === "/api/v1/auth/logout" ||
    url === "/api/v1/auth/logout-all" ||
    url === "/api/v1/auth/me" ||
    pathname === "/api/v1/auth/signup" ||
    pathname === "/api/v1/auth/login" ||
    pathname === "/api/v1/auth/refresh" ||
    pathname === "/api/v1/auth/logout" ||
    pathname === "/api/v1/auth/logout-all" ||
    pathname === "/api/v1/auth/me" ||
    // AUTH-BE-15 — verify, reset, and OTP are unauthenticated. Confirm/verify issue an
    // own-auth session themselves; they must not pass through the Clerk preHandler.
    url === "/api/v1/auth/verify-email/send" ||
    url === "/api/v1/auth/verify-email/confirm" ||
    url === "/api/v1/auth/password/forgot" ||
    url === "/api/v1/auth/password/reset" ||
    url === "/api/v1/auth/otp/send" ||
    url === "/api/v1/auth/otp/verify" ||
    pathname === "/api/v1/auth/verify-email/send" ||
    pathname === "/api/v1/auth/verify-email/confirm" ||
    pathname === "/api/v1/auth/password/forgot" ||
    pathname === "/api/v1/auth/password/reset" ||
    pathname === "/api/v1/auth/otp/send" ||
    pathname === "/api/v1/auth/otp/verify" ||
    // AUTH-BE-16 — Google sign-in start and callback are unauthenticated.
    url === "/api/v1/auth/google/start" ||
    url === "/api/v1/auth/google/callback" ||
    pathname === "/api/v1/auth/google/start" ||
    pathname === "/api/v1/auth/google/callback" ||
    // OAuth callbacks — Google/Microsoft redirect the browser here directly after consent, a
    // top-level navigation that can never carry our Authorization header. These were never
    // reachable without this: the global auth hook 401'd them with "Missing bearer token"
    // before the handler below got a chance to run. Each handler independently verifies the
    // signed `state` param (verifyOAuthState, same HMAC pattern as the already-public HubSpot
    // callback above) — that's the real auth here, not this header.
    url.startsWith("/api/v1/calendar/connect/google/callback") ||
    url.startsWith("/api/v1/inboxes/connect/google/callback") ||
    url.startsWith("/api/v1/inboxes/connect/microsoft/callback") ||
    url.startsWith("/api/v1/warmup-tool/oauth/google/callback") ||
    url.startsWith("/api/v1/warmup-tool/oauth/microsoft/callback") ||
    pathname.startsWith("/api/v1/calendar/connect/google/callback") ||
    pathname.startsWith("/api/v1/inboxes/connect/google/callback") ||
    pathname.startsWith("/api/v1/inboxes/connect/microsoft/callback") ||
    pathname.startsWith("/api/v1/warmup-tool/oauth/google/callback") ||
    pathname.startsWith("/api/v1/warmup-tool/oauth/microsoft/callback") ||
    // R20.2 — Twilio calls these directly; not signature-verified yet (see dependency doc).
    url.startsWith("/api/v1/calls/twiml/") ||
    url.startsWith("/api/v1/calls/status") ||
    url.startsWith("/api/v1/calls/recording-status") ||
    pathname.startsWith("/api/v1/calls/twiml/") ||
    pathname.startsWith("/api/v1/calls/status") ||
    pathname.startsWith("/api/v1/calls/recording-status") ||
    // AUTH-BE-12 — public JWKS for own-auth token verification (contains no private material).
    url === "/.well-known/jwks.json" ||
    pathname === "/.well-known/jwks.json" ||
    isInviteTokenLookup
  );
}

export { computeAuthorizedParties, normalizeOrigin };

export const authPlugin = fp(async (app) => {
  const config = app.config;

  const authRuntime = authRuntimeFlags({ ...config, appRole: "api" });

  if (authRuntime.AUTH_MODE === "custom") {
    throw new Error("AUTH_MODE=custom is not enabled in apps/api yet — use clerk or dual");
  }

  if (authRuntime.AUTH_USE_STUB) {
    app.log.warn(
      config.AUTH_STUB
        ? "AUTH_STUB=true — JWT disabled, using stub user"
        : "CLERK_SECRET_KEY not set — running in stub mode"
    );
    app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
      // CORS preflight (and any OPTIONS) must never require auth.
      if (request.method === "OPTIONS") return;
      if (isHealthRoute(request.url) || isPublicRoute(request.url, request.method)) return;
      if (applyEmailIntelIdentity(request, config)) {
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
    app.addHook("preHandler", async (request) => {
      if (!app.db || !request.userId || !request.workspaceId || request.platformContext) return;
      try {
        request.platformContext = await loadPlatformContext(app.db, {
          workspaceId: request.workspaceId,
          userId: request.userId,
        });
      } catch (err) {
        app.log.warn({ err }, "PlatformContext load failed — continuing without it");
      }
    });
    return;
  }

  const resolveAuthConfig = buildApiResolveAuthConfig(config);

  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    // CORS preflight (and any OPTIONS) must never require auth.
    if (request.method === "OPTIONS") {
      return;
    }
    if (isHealthRoute(request.url) || isPublicRoute(request.url, request.method)) {
      return;
    }
    if (applyEmailIntelIdentity(request, config)) {
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
      return reply
        .code(401)
        .send(authErrorResponse(AuthErrorCode.AUTH_MISSING_TOKEN, AuthErrorMessage.MISSING_BEARER, 401));
    }

    // Static-secret admin import auth (/admin/import page in the frontend). Deliberately
    // scoped to import routes only — a leaked ADMIN_IMPORT_SECRET can seed data, nothing else.
    if (token.startsWith("admin_")) {
      const isImportRoute = request.url.split("?")[0]!.startsWith("/api/v1/import/");
      const secret = config.ADMIN_IMPORT_SECRET;
      const targetWorkspaceId = config.ADMIN_IMPORT_WORKSPACE_ID;
      if (!isImportRoute || !secret || !targetWorkspaceId) {
        return reply
          .code(401)
          .send(
            authErrorResponse(
              AuthErrorCode.AUTH_TOKEN_INVALID,
              AuthErrorMessage.INVALID_AUTHORIZATION,
              401
            )
          );
      }
      const provided = token.slice("admin_".length);
      if (!timingSafeEqualStrings(provided, secret)) {
        return reply
          .code(401)
          .send(
            authErrorResponse(
              AuthErrorCode.AUTH_TOKEN_INVALID,
              AuthErrorMessage.INVALID_AUTHORIZATION,
              401
            )
          );
      }
      request.userId = "admin-import";
      request.userEmail = "admin-import@skoutai.internal";
      request.workspaceId = targetWorkspaceId;
      request.role = "admin";
      return;
    }

    // Invite session token (issued after OTP verification) — AUTH-BE-26
    if (token.startsWith("isk_")) {
      const session = await verifyInviteSession(db, token);
      if (!session) {
        return reply
          .code(401)
          .send(
            authErrorResponse(
              AuthErrorCode.AUTH_SESSION_INVALID,
              AuthErrorMessage.SESSION_EXPIRED_OR_INVALID,
              401
            )
          );
      }

      request.userId = session.userId;
      request.userEmail = session.email;
      request.workspaceId = session.workspaceId;
      request.role = session.role;
      return;
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
      // DB errors during provisioning are server failures, not invalid tokens.
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

  // §7 — attach PlatformContext after identity is resolved (best-effort; never blocks the request).
  app.addHook("preHandler", async (request) => {
    if (!app.db || !request.userId || !request.workspaceId || request.platformContext) return;
    try {
      request.platformContext = await loadPlatformContext(app.db, {
        workspaceId: request.workspaceId,
        userId: request.userId,
      });
    } catch (err) {
      app.log.warn({ err }, "PlatformContext load failed — continuing without it");
    }
  });
});
