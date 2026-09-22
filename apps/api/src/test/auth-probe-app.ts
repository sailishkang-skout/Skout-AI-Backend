import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { loadEnv, type Env } from "../config/env.js";
import { authPlugin } from "../plugins/auth.js";
import { errorResponse } from "../utils/http.js";

/** Minimal app for auth-plugin behavior tests (no full route graph / workspace packages). */
export async function buildAuthProbeApp(overrides: Partial<Env> = {}): Promise<FastifyInstance> {
  const config = { ...loadEnv(), ...overrides };
  const app = Fastify({ logger: { level: "fatal" } });
  app.decorate("config", config);
  app.decorate("db", { __authProbe: true });

  await app.register(authPlugin);

  app.get("/api/v1/__auth_probe", async (request) => ({
    userId: request.userId,
    workspaceId: request.workspaceId,
    role: request.role,
  }));

  app.get("/api/v1/import/admin/ping", async (request, reply) => {
    if (!request.workspaceId) {
      return reply.code(401).send(errorResponse("Not authenticated", 401));
    }
    return reply.send({ data: { ok: true, workspaceId: request.workspaceId } });
  });

  app.post("/api/v1/email-intel/verify", async () => ({ ok: true }));

  await app.ready();
  return app;
}
