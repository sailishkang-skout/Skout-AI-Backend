import type { FastifyInstance } from "fastify";
import { integrationService } from "../services/integration.service.js";

const DEFAULT_WS = "00000000-0000-4000-8000-000000000001";

export async function integrationRoutes(app: FastifyInstance) {
  app.get("/integrations", async (request, reply) => {
    const workspaceId = request.workspaceId ?? DEFAULT_WS;
    const data = await integrationService.list(workspaceId);
    return reply.send({ workspaceId, data });
  });

  app.put("/integrations/:provider", async (request, reply) => {
    const { provider } = request.params as { provider: string };
    const workspaceId = request.workspaceId ?? DEFAULT_WS;
    const body = (request.body ?? {}) as { apiKey?: string; dsn?: string };
    if (!body.apiKey) {
      return reply.status(400).send({ error: "apiKey is required" });
    }
    try {
      const item = await integrationService.save(workspaceId, provider, body.apiKey, body.dsn);
      return reply.send({ data: item });
    } catch (err) {
      return reply.status(400).send({ error: errMessage(err) });
    }
  });

  app.delete("/integrations/:provider", async (request, reply) => {
    const { provider } = request.params as { provider: string };
    const workspaceId = request.workspaceId ?? DEFAULT_WS;
    await integrationService.remove(workspaceId, provider);
    return reply.status(204).send();
  });

  app.post("/integrations/:provider/test", async (request, reply) => {
    const { provider } = request.params as { provider: string };
    const workspaceId = request.workspaceId ?? DEFAULT_WS;
    const body = (request.body ?? {}) as { apiKey?: string; dsn?: string };
    try {
      const result = await integrationService.test(workspaceId, provider, body.apiKey, body.dsn);
      return reply.send(result);
    } catch (err) {
      return reply.status(400).send({ error: errMessage(err) });
    }
  });
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Request failed";
}
