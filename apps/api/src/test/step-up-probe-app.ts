import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { Db } from "@skout/db";
import { loadEnv, type Env } from "../config/env.js";
import { authPlugin } from "../plugins/auth.js";
import { stepUpRoutes } from "../routes/step-up.routes.js";

/** Minimal app for POST /auth/step-up tests (auth plugin + step-up route only). */
export async function buildStepUpProbeApp(
  overrides: Partial<Env> = {},
  db?: Db
): Promise<FastifyInstance> {
  const config = { ...loadEnv(), ...overrides };
  const app = Fastify({ logger: { level: "fatal" } });
  app.decorate("config", config);
  app.decorate("db", (db ?? {}) as never);

  await app.register(authPlugin);
  await app.register(
    async (scope) => {
      await scope.register(stepUpRoutes);
    },
    { prefix: "/api/v1" }
  );

  await app.ready();
  return app;
}
