import type { FastifyInstance } from "fastify";
import { dashboardService } from "../services/dashboard.service.js";

export async function dashboardRoutes(app: FastifyInstance) {
  app.get("/dashboard/summary", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const summary = await dashboardService.getSummary(workspaceId);
    return reply.send({ data: summary });
  });
}
