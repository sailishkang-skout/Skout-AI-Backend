import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { Env } from "../config/env.js";

export const securityPlugin = fp(async (app: FastifyInstance, config: Env) => {
  app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  });

  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    allowList: (req) => req.url.startsWith("/api/v1/health") || req.url.startsWith("/health"),
    keyGenerator: (req) => {
      const auth = req.headers.authorization;
      if (typeof auth === "string" && auth.startsWith("Bearer ")) {
        return `user:${auth.slice(7, 24)}`;
      }
      return req.ip;
    },
    errorResponseBuilder: (_req, context) => ({
      error: "rate_limit_exceeded",
      message: `Too many requests. Retry in ${Math.ceil(context.ttl / 1000)}s.`,
      statusCode: 429,
    }),
  });
});
