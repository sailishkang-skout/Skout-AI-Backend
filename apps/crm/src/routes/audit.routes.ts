import type { FastifyInstance } from "fastify";
import { HttpError } from "@skout/auth";
import { auditLogListQuerySchema } from "@skout/shared";
import { buildAuditService } from "../services/audit.service.js";

export async function auditRoutes(app: FastifyInstance) {
  const service = () => buildAuditService(app.db ?? null);

  app.get("/audit-logs", async (request) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const { entityType, entityId } = auditLogListQuerySchema.parse(request.query);
    const svc = service();
    if (!svc) return { data: [], total: 0, workspaceId };

    const result = await svc.list(workspaceId, entityType, entityId, { limit: 100, offset: 0 });
    return { ...result, workspaceId };
  });
}
