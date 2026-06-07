import type { FastifyInstance } from "fastify";
import { prospectService } from "../services/prospect.service.js";

export async function prospectRoutes(app: FastifyInstance) {
  app.get("/prospects", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const result = await prospectService.listActivated(workspaceId);
    return reply.send(result);
  });

  app.post("/prospects/:id/enrich", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const result = await prospectService.enrich(id, workspaceId);
    return reply.status(202).send(result);
  });
}
