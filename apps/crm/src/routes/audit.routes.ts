import type { FastifyInstance } from "fastify";
import { HttpError } from "@skout/auth";
import { auditLogListQuerySchema } from "@skout/shared";
import { buildAuditService } from "../services/audit.service.js";

export async function auditRoutes(app: FastifyInstance) {
  const service = () => buildAuditService(app.db ?? null);

  app.get("/audit-logs", async (request) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const { entityType, entityId, limit, offset } = auditLogListQuerySchema.parse(request.query);
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const result = await svc.list(workspaceId, entityType, entityId, { limit, offset });
    return { ...result, workspaceId };
  });
}
