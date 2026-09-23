import { createHash } from "node:crypto";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { AuthErrorCode, authErrorResponse } from "@skout/auth";
import type { Env } from "../config/env.js";

/** Own-auth routes get their own bucket so a login storm cannot exhaust the global API limit. */
const AUTH_ROUTE_LIMIT = 30;

function isAuthRoute(url: string): boolean {
  return (url.split("?")[0] ?? url).startsWith("/api/v1/auth/");
}

function bearerHash(authorization: string | undefined): string | null {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ") || authorization.length <= 7) {
    return null;
  }
  return createHash("sha256").update(authorization.slice(7)).digest("hex").slice(0, 32);
}

function rateLimitKey(req: { headers: { authorization?: string }; ip: string; url: string }): string {
  const authKey = bearerHash(req.headers.authorization);
  if (isAuthRoute(req.url)) {
    // Unauthenticated auth routes (login, signup, verify, reset) are limited per IP.
    // Bearer routes (me, logout-all) are limited per token so one user cannot lock the IP.
    return authKey ? `auth-user:${authKey}` : `auth-ip:${req.ip}`;
  }
  if (authKey) return `user:${authKey}`;
  return req.ip;
}

export const securityPlugin = fp(async (app: FastifyInstance, config: Env) => {
  app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  });

  await app.register(rateLimit, {
    global: true,
    max: (req: FastifyRequest) =>
      isAuthRoute(req.url) ? Math.min(config.RATE_LIMIT_MAX, AUTH_ROUTE_LIMIT) : config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    allowList: (req) =>
      req.url.startsWith("/api/v1/health") ||
      req.url.startsWith("/api/v1/slo") ||
      req.url.startsWith("/api/v1/metrics") ||
      req.url.startsWith("/health"),
    keyGenerator: rateLimitKey,
    errorResponseBuilder: (req: FastifyRequest, context) => {
      if (isAuthRoute(req.url)) {
        return authErrorResponse(AuthErrorCode.AUTH_RATE_LIMITED, "Too many attempts. Try again later.", 429);
      }
      return {
        error: "rate_limit_exceeded",
        message: `Too many requests. Retry in ${Math.ceil(context.ttl / 1000)}s.`,
        statusCode: 429,
      };
    },
  });
});
