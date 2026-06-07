import type { FastifyInstance } from "fastify";
import { aiService } from "../services/ai.service.js";

export async function aiRoutes(app: FastifyInstance) {
  app.get("/ai/drafts", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    return reply.send(await aiService.listDrafts(workspaceId));
  });
}
