import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import { ZodError } from "zod";
import { buildPinoOptions, captureException } from "@skout/observability";
import type { Env } from "./config/env.js";
import { authPlugin } from "./plugins/auth.js";
import { configPlugin } from "./plugins/config.js";
import { dbPlugin } from "./plugins/db.js";
import { loggingPlugin } from "./plugins/logging.js";
import { securityPlugin } from "./plugins/security.js";
import { registerRoutes } from "./routes/index.js";
import { apiError, HttpError, isDatabaseError } from "./utils/http.js";

export async function buildApp(config: Env) {
  const app = Fastify({
    logger: buildPinoOptions({
      service: config.SERVICE_NAME,
      level: config.LOG_LEVEL,
      environment: config.NODE_ENV,
      version: config.SERVICE_VERSION,
    }),
    trustProxy: config.TRUST_PROXY,
    bodyLimit: config.REQUEST_BODY_LIMIT_BYTES,
    requestIdHeader: "x-request-id",
    genReqId: (req) =>
      (typeof req.headers["x-request-id"] === "string"
        ? req.headers["x-request-id"]
        : undefined) ?? randomUUID(),
    pluginTimeout: 30_000,
  });

  await app.register(loggingPlugin);
  await app.register(securityPlugin, config);

  // Preserve the raw request body alongside the parsed JSON. Webhook signature verification
  // (the inbound meeting-RSVP webhook) must hash the exact bytes the caller sent — re-serializing
  // the parsed object produces a different string and fails. Same pattern as apps/api's app.ts.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string", bodyLimit: config.REQUEST_BODY_LIMIT_BYTES },
    (request, body, done) => {
      const raw = typeof body === "string" ? body : body.toString();
      request.rawBody = raw;
      if (!raw) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(raw));
      } catch (err) {
        (err as { statusCode?: number }).statusCode = 400;
        done(err as Error, undefined);
      }
    }
  );

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send(
        apiError("validation_error", "Request validation failed", 400, {
          issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        })
      );
    }

    if (error instanceof HttpError) {
      request.log.warn(
        { err: error, statusCode: error.statusCode, details: error.details },
        error.message
      );
      return reply
        .code(error.statusCode)
        .send(
          apiError(error.message, error.message, error.statusCode, error.details ? { details: error.details } : undefined)
        );
    }

    const dbError = isDatabaseError(error);
    const statusCode = dbError
      ? 500
      : typeof error === "object" && error !== null && "statusCode" in error
        ? Number((error as { statusCode?: number }).statusCode) || 500
        : 500;

    if (statusCode >= 500) {
      request.log.error({ err: error }, "unhandled error");
      captureException(error, {
        path: request.url,
        method: request.method,
        userId: request.userId,
        workspaceId: request.workspaceId,
      });
      return reply
        .code(statusCode)
        .send(apiError("internal_server_error", "An internal server error occurred. Please try again.", statusCode));
    }

    request.log.warn({ err: error }, "request error");
    const message = error instanceof Error ? error.message : "request_error";
    reply.code(statusCode).send(apiError(message, message, statusCode));
  });

  await app.register(configPlugin, config);
  await app.register(dbPlugin);
  await app.register(authPlugin);

  const allowedOrigins = config.CORS_ORIGIN.map((o) => o.toLowerCase());

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) {
        cb(null, true);
        return;
      }
      if (allowedOrigins.includes(origin.toLowerCase())) {
        cb(null, origin);
        return;
      }
      cb(null, false);
    },
    credentials: true,
    exposedHeaders: ["x-request-id"],
  });

  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split("?")[0];
    return reply
      .code(404)
      .send(apiError("not_found", `Route ${request.method} ${pathname} not found.`, 404));
  });

  await registerRoutes(app);

  return app;
}
