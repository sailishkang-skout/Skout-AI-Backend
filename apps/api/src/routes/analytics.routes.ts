import type { FastifyInstance } from "fastify";
import { createAnalyticsService } from "../services/analytics.service.js";
import { errorResponse } from "../utils/http.js";

export async function analyticsRoutes(app: FastifyInstance) {
  app.get("/analytics/report", async (request, reply) => {
    if (!request.workspaceId) {
      return reply.code(401).send(errorResponse("Not authenticated", 401));
    }
    const query = request.query as { days?: string };
    const days = parseInt(query.days ?? "30", 10) || 30;
    const svc = createAnalyticsService(app.db, app.config);
    const data = await svc.getReport(request.workspaceId, days);
    return reply.send({ data });
  });
}
