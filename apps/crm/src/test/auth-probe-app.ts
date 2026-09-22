import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { loadEnv, type Env } from "../config/env.js";
import { authPlugin } from "../plugins/auth.js";

/** Minimal CRM app for auth-plugin tests (no DB plugin). */
export async function buildAuthProbeApp(overrides: Partial<Env> = {}): Promise<FastifyInstance> {
  const config = { ...loadEnv(), ...overrides };
  const app = Fastify({ logger: { level: "fatal" } });
  app.decorate("config", config);
  app.decorate("db", {} as never);

  await app.register(authPlugin);

  app.get("/api/v1/__auth_probe", async (request) => ({
    userId: request.userId,
    workspaceId: request.workspaceId,
    role: request.role,
  }));

  app.get("/internal/v1/__probe", async () => ({ ok: true }));

  await app.ready();
  return app;
}
