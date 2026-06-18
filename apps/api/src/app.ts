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
import { workspaceContext } from "./plugins/workspace-context.js";
import { registerRoutes } from "./routes/index.js";
import { HttpError } from "./utils/http.js";

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
  });

  await app.register(loggingPlugin);
  await app.register(securityPlugin, config);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "validation_error",
        issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }

    if (error instanceof HttpError) {
      request.log.warn(
        { err: error, statusCode: error.statusCode, details: error.details },
        error.message
      );
      return reply
        .code(error.statusCode)
        .send({ error: error.message, ...(error.details ? { details: error.details } : {}) });
    }

    const statusCode =
      typeof error === "object" && error !== null && "statusCode" in error
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
    } else {
      request.log.warn({ err: error }, "request error");
    }

    const message = error instanceof Error ? error.message : "internal_server_error";
    reply.code(statusCode).send({ error: message });
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

  app.addHook("preHandler", workspaceContext);

  await registerRoutes(app);

  return app;
}
