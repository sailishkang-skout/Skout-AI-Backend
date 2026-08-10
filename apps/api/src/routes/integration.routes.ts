import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createIntegrationService } from "../services/integration.service.js";
import { importApolloSequence, listApolloSequences } from "../services/apollo-import.service.js";
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

  // R22.3 — browse the workspace's Apollo sequences ("Emailer Campaigns") to import.
  app.get("/integrations/apollo/sequences", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    if (!app.db) return reply.status(500).send(errorResponse("Database not available", 500));
    const svc = createIntegrationService(app.db, app.config);
    const apiKey = await svc.getDecryptedProviderKey(workspaceId, "apollo");
    if (!apiKey) {
      return reply.status(422).send(errorResponse("Connect Apollo in Settings → Integrations first", 422));
    }
    try {
      const data = await listApolloSequences(apiKey);
      return reply.send({ data });
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send(errorResponse(err.message, err.statusCode, err.details));
      }
      throw err;
    }
  });

  // R22.3 — import one Apollo sequence as a Skout draft sequence.
  app.post("/integrations/apollo/sequences/:id/import", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const { id } = request.params as { id: string };
    if (!app.db) return reply.status(500).send(errorResponse("Database not available", 500));
    const svc = createIntegrationService(app.db, app.config);
    const apiKey = await svc.getDecryptedProviderKey(workspaceId, "apollo");
    if (!apiKey) {
      return reply.status(422).send(errorResponse("Connect Apollo in Settings → Integrations first", 422));
    }
    try {
      const result = await importApolloSequence(app.db, workspaceId, apiKey, id);
      return reply.code(201).send({ data: result });
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send(errorResponse(err.message, err.statusCode, err.details));
      }
      throw err;
    }
  });
}
