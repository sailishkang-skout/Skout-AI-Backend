import type { FastifyInstance } from "fastify";
import { crmService } from "../services/crm.service.js";

export async function crmRoutes(app: FastifyInstance) {
  app.get("/crm/connections", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    return reply.send(await crmService.listConnections(workspaceId));
  });
}

export async function webhookRoutes(app: FastifyInstance) {
  app.get("/webhooks", async (_request, reply) => {
    return reply.send({ data: [], total: 0 });
  });
}
