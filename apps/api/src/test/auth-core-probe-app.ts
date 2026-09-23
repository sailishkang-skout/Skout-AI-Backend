import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import type { Db } from "@skout/db";
import { loadEnv, type Env } from "../config/env.js";
import { authCoreRoutes } from "../routes/auth-core.routes.js";

/** Minimal app for AUTH-BE-14 route-level tests: cookie parsing + the real routes, no full
 *  route graph, no rate-limit plugin (route-level `config.rateLimit` is inert without it,
 *  which is fine — lockout logic itself is exercised directly via session/lockout tests). */
export async function buildAuthCoreProbeApp(
  db: Db,
  overrides: Partial<Env> = {}
): Promise<FastifyInstance> {
  const config: Env = { ...loadEnv(), AUTH_CUSTOM_ENABLED: true, ...overrides };
  const app = Fastify({ logger: { level: "fatal" } });
  app.decorate("config", config);
  app.decorate("db", db);
  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    // eslint-disable-next-line no-console
    console.error("[auth-core-probe-app] unhandled error:", error);
    const statusCode = error.statusCode ?? 500;
    reply.code(statusCode).send({ ok: false, error: error.message, statusCode });
  });
  await app.register(cookie);
  await app.register(async (v1) => {
    await v1.register(authCoreRoutes);
  }, { prefix: "/api/v1" });
  await app.ready();
  return app;
}
