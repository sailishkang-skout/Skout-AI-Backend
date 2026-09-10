import { createHash } from "node:crypto";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { Env } from "../config/env.js";

function isHealthPath(url: string): boolean {
  const pathname = url.split("?")[0];
  return pathname === "/api/v1/crm/health" || pathname.startsWith("/health");
}

function rateLimitKey(req: { headers: { authorization?: string }; ip: string }): string {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ") && auth.length > 7) {
    return `user:${createHash("sha256").update(auth.slice(7)).digest("hex").slice(0, 32)}`;
  }
  return req.ip;
}

export const securityPlugin = fp(async (app: FastifyInstance, config: Env) => {
  app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  });

  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    allowList: (req) => isHealthPath(req.url),
    keyGenerator: rateLimitKey,
    errorResponseBuilder: (_req, context) => ({
      error: "rate_limit_exceeded",
      message: `Too many requests. Retry in ${Math.ceil(context.ttl / 1000)}s.`,
      statusCode: 429,
    }),
  });
});
