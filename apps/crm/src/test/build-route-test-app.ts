import Fastify, { type FastifyInstance } from "fastify";
import { registerRoutes } from "../routes/index.js";

const DEFAULT_WORKSPACE_ID = "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee";

/** Lightweight app for route unit tests — skips DB and Clerk. */
export async function buildRouteTestApp(
  workspaceId = DEFAULT_WORKSPACE_ID
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.addHook("preHandler", async (request) => {
    request.userId = "test-user-id";
    request.userEmail = "test@example.com";
    request.workspaceId = workspaceId;
    request.role = "owner";
  });

  await registerRoutes(app);
  return app;
}
