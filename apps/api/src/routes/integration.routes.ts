import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createIntegrationService } from "../services/integration.service.js";
import { HttpError, errorResponse } from "../utils/http.js";

const saveSchema = z.object({
  apiKey: z.string().min(8).max(512),
  dsn: z.string().url().optional(),
});

const testSchema = z.object({
  apiKey: z.string().min(8).max(512).optional(),
  dsn: z.string().url().optional(),
});

export async function integrationRoutes(app: FastifyInstance) {
  app.get("/integrations", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = createIntegrationService(app.db, app.config);
    return reply.send(await svc.list(workspaceId));
  });

  app.put("/integrations/:provider", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const { provider } = request.params as { provider: string };
    const body = saveSchema.parse(request.body ?? {});
    const svc = createIntegrationService(app.db, app.config);
    try {
      const data = await svc.save(workspaceId, provider, body.apiKey, { dsn: body.dsn });
      return reply.send({ data });
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send(errorResponse(err.message, err.statusCode, err.details));
      }
      throw err;
    }
  });

  app.delete("/integrations/:provider", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const { provider } = request.params as { provider: string };
    const svc = createIntegrationService(app.db, app.config);
    try {
      await svc.remove(workspaceId, provider);
      return reply.status(204).send();
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send(errorResponse(err.message, err.statusCode, err.details));
      }
      throw err;
    }
  });

  app.post("/integrations/:provider/test", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const { provider } = request.params as { provider: string };
    const body = testSchema.parse(request.body ?? {});
    const svc = createIntegrationService(app.db, app.config);
    try {
      return reply.send(await svc.test(workspaceId, provider, body.apiKey, { dsn: body.dsn }));
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send(errorResponse(err.message, err.statusCode, err.details));
      }
      throw err;
    }
  });
}
