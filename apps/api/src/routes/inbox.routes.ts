import type { FastifyInstance } from "fastify";
import { inboxService } from "../services/inbox.service.js";

export async function inboxRoutes(app: FastifyInstance) {
  app.get("/inboxes", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    return reply.send(await inboxService.listInboxes(workspaceId));
  });

  app.get("/domains", async (_request, reply) => {
    return reply.send({ data: [], total: 0 });
  });

  app.get("/inbox/threads", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    return reply.send(await inboxService.listThreads(workspaceId));
  });
}
