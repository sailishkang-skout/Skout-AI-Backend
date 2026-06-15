import Fastify from "fastify";
import cors from "@fastify/cors";
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

  await app.register(configPlugin, config);
  await app.register(dbPlugin);
  await app.register(authPlugin);

  await app.register(cors, {
    origin: config.CORS_ORIGIN,
    credentials: true,
  });

  app.addHook("preHandler", workspaceContext);

  await registerRoutes(app);

  return app;
}
