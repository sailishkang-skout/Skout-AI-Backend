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
    // Default find-my-way maxParamLength (100) is too short for HMAC-signed
    // tracking/unsubscribe tokens, which routinely exceed it (the click token
    // embeds the destination URL in its payload).
    routerOptions: { maxParamLength: 1000 },
    genReqId: (req) =>
      (typeof req.headers["x-request-id"] === "string"
        ? req.headers["x-request-id"]
        : undefined) ?? randomUUID(),
    // Remote databases (e.g. Supabase) need more than the 10 s default.
    pluginTimeout: 30_000,
  });

  await app.register(loggingPlugin);
  await app.register(securityPlugin, config);

  // Preserve the raw request body alongside the parsed JSON. Webhook signature
  // verification (e.g. Razorpay) must hash the exact bytes the provider sent —
  // re-serializing the parsed object produces a different string and fails.
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

    // Database errors (Drizzle/postgres) must never be returned verbatim — they
    // leak SQL statements and schema. Always treat them as opaque 500s.
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
      // Generic message for all server errors — no raw error/SQL text to clients.
      return reply
        .code(statusCode)
        .send(apiError("internal_server_error", "An internal server error occurred. Please try again.", statusCode));
    }

    request.log.warn({ err: error }, "request error");
    const message = error instanceof Error ? error.message : "request_error";
    reply.code(statusCode).send(apiError(message, message, statusCode));
  });

  // Normalize every error response to a consistent shape: { error, message,
  // statusCode, ...extra }. Routes historically returned a mix of
  // { error }, { error, message }, { ok, error, statusCode } etc.
  app.addHook("onSend", async (_request, reply, payload) => {
    if (reply.statusCode < 400 || typeof payload !== "string") return payload;
    const contentType = String(reply.getHeader("content-type") ?? "");
    if (!contentType.includes("application/json")) return payload;
    try {
      const body = JSON.parse(payload);
      if (body && typeof body === "object" && !Array.isArray(body) && "error" in body) {
        const code = typeof body.error === "string" ? body.error : "error";
        const normalized = {
          ...body,
          error: code,
          message: typeof body.message === "string" ? body.message : code,
          statusCode: typeof body.statusCode === "number" ? body.statusCode : reply.statusCode,
        };
        return JSON.stringify(normalized);
      }
    } catch {
      // Not JSON we can normalize — leave as-is.
    }
    return payload;
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

  // Track registered routes so the not-found handler can distinguish a genuinely
  // unknown path (404) from a known path hit with an unsupported method (405).
  const routeMethods = new Map<string, Set<string>>();
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const existing = routeMethods.get(route.url) ?? new Set<string>();
    for (const m of methods) existing.add(m.toUpperCase());
    routeMethods.set(route.url, existing);
  });

  function matchKnownPath(pathname: string): Set<string> | undefined {
    if (routeMethods.has(pathname)) return routeMethods.get(pathname);
    // Match parameterized routes (e.g. /lists/:id) against the concrete path.
    for (const [pattern, methods] of routeMethods) {
      if (!pattern.includes(":") && !pattern.includes("*")) continue;
      const regex = new RegExp(
        "^" +
          pattern
            .replace(/\/:[^/]+/g, "/[^/]+")
            .replace(/\/\*/g, "/.*")
            .replace(/[.+?^${}()|[\]\\]/g, (c) => (c === "." ? "\\." : c)) +
          "$"
      );
      if (regex.test(pathname)) return methods;
    }
    return undefined;
  }

  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split("?")[0];
    const known = matchKnownPath(pathname);
    if (known && known.size > 0 && request.method !== "OPTIONS") {
      const allow = [...known].sort().join(", ");
      return reply
        .code(405)
        .header("Allow", allow)
        .send(
          apiError(
            "method_not_allowed",
            `Method ${request.method} is not allowed on ${pathname}. Allowed: ${allow}.`,
            405,
            { allow }
          )
        );
    }
    return reply
      .code(404)
      .send(apiError("not_found", `Route ${request.method} ${pathname} not found.`, 404));
  });

  await registerRoutes(app);

  return app;
}
