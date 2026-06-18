import Fastify from "fastify";
import cors from "@fastify/cors";
import { ZodError } from "zod";
import type { Env } from "./config/env.js";
import { authPlugin } from "./plugins/auth.js";
import { configPlugin } from "./plugins/config.js";
import { dbPlugin } from "./plugins/db.js";
import { workspaceContext } from "./plugins/workspace-context.js";
import { registerRoutes } from "./routes/index.js";

export async function buildApp(config: Env) {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
    },
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "validation_error",
        issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    app.log.error(error);
    const statusCode =
      typeof error === "object" && error !== null && "statusCode" in error
        ? Number((error as { statusCode?: number }).statusCode) || 500
        : 500;
    const message = error instanceof Error ? error.message : "internal_server_error";
    reply.code(statusCode).send({ error: message });
  });

  await app.register(configPlugin, config);
  await app.register(dbPlugin);
  await app.register(authPlugin);

  const allowedOrigins = config.CORS_ORIGIN.map((o) => o.toLowerCase());

  await app.register(cors, {
    origin: (origin, cb) => {
      // Non-browser or same-origin requests (no Origin header).
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
  });

  app.addHook("preHandler", workspaceContext);

  await registerRoutes(app);

  return app;
}
