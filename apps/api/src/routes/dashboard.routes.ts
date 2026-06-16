import type { FastifyInstance } from "fastify";
import { createDashboardService } from "../services/dashboard.service.js";

export async function dashboardRoutes(app: FastifyInstance) {
  app.get("/dashboard/summary", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = createDashboardService(app.db, app.config);
    return reply.send({ data: await svc.getSummary(workspaceId) });
  });
}
