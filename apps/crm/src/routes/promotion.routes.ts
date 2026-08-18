import type { FastifyInstance } from "fastify";
import { HttpError } from "@skout/auth";
import { listPendingCandidates, promoteProspectToDeal } from "@skout/crm-bridge";
import { parseIdParam } from "../utils/http.js";
import { buildAuditService } from "../services/audit.service.js";
import { buildPipelinesService } from "../services/pipelines.service.js";

export async function promotionRoutes(app: FastifyInstance) {
  app.get("/promotion-candidates", async (request) => {
    const workspaceId = request.workspaceId ?? "unknown";
    if (!app.db) throw new HttpError("database_unavailable", 503);
    const candidates = await listPendingCandidates(app.db, workspaceId);
    return { data: candidates };
  });

  app.post("/promotion-candidates/:id/promote", async (request, reply) => {
    const id = parseIdParam(request);
    const workspaceId = request.workspaceId ?? "unknown";
    if (!app.db) throw new HttpError("database_unavailable", 503);

    const auditService = buildAuditService(app.db)!;
    const pipelinesService = buildPipelinesService(app.db, auditService)!;
    // crm-bridge never creates pipelines itself — guarantee one exists first, owned by
    // apps/crm's PipelinesService.
    await pipelinesService.ensureDefaultPipeline(workspaceId);

    try {
      const result = await promoteProspectToDeal(app.db, workspaceId, id, request.userId);
      return reply.code(201).send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "promotion_failed";
      if (message === "promotion_candidate_not_found") throw new HttpError(message, 404);
      if (message === "promotion_candidate_already_promoted") throw new HttpError(message, 409);
      throw err;
    }
  });
}
