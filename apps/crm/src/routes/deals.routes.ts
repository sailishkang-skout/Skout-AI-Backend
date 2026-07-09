import type { FastifyInstance } from "fastify";

/** Placeholder until native deals/pipelines tables land in Phase 2. */
export async function dealsRoutes(app: FastifyInstance) {
  app.get("/deals", async (request) => {
    const workspaceId = request.workspaceId ?? "unknown";
    return {
      data: [],
      total: 0,
      workspaceId,
      message: "CRM deals module scaffold — pipeline records will appear here after schema migration.",
    };
  });

  app.get("/deals/summary", async (request) => {
    const workspaceId = request.workspaceId ?? "unknown";
    return {
      workspaceId,
      openDeals: 0,
      pipelineValue: 0,
      currency: "USD",
      stages: [],
    };
  });
}
