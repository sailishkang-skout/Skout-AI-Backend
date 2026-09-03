import type { FastifyInstance } from "fastify";
import { getModelPerformanceReport } from "../services/model-performance.service.js";
import { requireWorkspaceId } from "../utils/http.js";

/** 8.15 task 34 — model/prompt performance tracking: precision, calibration, override rate,
 * action acceptance, downstream outcome, fairness/drift. */
export async function modelPerformanceRoutes(app: FastifyInstance) {
  app.get("/model-performance", async (request, reply) => {
    const workspaceId = requireWorkspaceId(request);
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const report = await getModelPerformanceReport(app.db, app.config, workspaceId);
    return reply.send(report);
  });
}
