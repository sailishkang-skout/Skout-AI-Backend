import { createHash } from "node:crypto";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { Env } from "../config/env.js";

function rateLimitKey(req: { headers: { authorization?: string }; ip: string }): string {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ") && auth.length > 7) {
    // Hash full token — prefix slice collides across users and leaks token material into Redis keys.
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
    allowList: (req) =>
      req.url.startsWith("/api/v1/health") ||
      req.url.startsWith("/api/v1/slo") ||
      req.url.startsWith("/api/v1/metrics") ||
      req.url.startsWith("/health"),
    keyGenerator: rateLimitKey,
    errorResponseBuilder: (_req, context) => ({
      error: "rate_limit_exceeded",
      message: `Too many requests. Retry in ${Math.ceil(context.ttl / 1000)}s.`,
      statusCode: 429,
    }),
  });
});
