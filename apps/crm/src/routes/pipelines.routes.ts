import type { FastifyInstance } from "fastify";
import { pipelineCreateSchema, pipelineStageCreateSchema, pipelineUpdateSchema } from "@skout/shared";
import { HttpError, enforcePermission } from "@skout/auth";
import { parseIdParam } from "../utils/http.js";
import { requireRole } from "../utils/require-role.js";
import { buildAuditService } from "../services/audit.service.js";
import { buildPipelinesService } from "../services/pipelines.service.js";

export async function pipelinesRoutes(app: FastifyInstance) {
  const service = () => {
    const db = app.db ?? null;
    const auditService = buildAuditService(db);
    return buildPipelinesService(db, auditService);
  };

  async function shadowCrmManage(request: { userId?: string; workspaceId?: string }, action: string) {
    const workspaceId = request.workspaceId ?? "unknown";
    if (app.db && request.userId) {
      await enforcePermission(app.db, workspaceId, request.userId, "crm:manage", {
        enforce: app.config.RBAC_ENFORCEMENT_ENABLED,
        onShadowDeny: (info) =>
          app.log.warn(info, `RBAC shadow-mode: crm:manage would have been denied (${action})`),
      });
    }
  }

  app.get("/pipelines", async (request) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const data = await svc.list(workspaceId);
    return { data, total: data.length, workspaceId };
  });

  app.post("/pipelines", async (request, reply) => {
    requireRole(request, ["owner", "admin", "member"]);
    await shadowCrmManage(request, "create pipeline");
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const input = pipelineCreateSchema.parse(request.body);
    const pipeline = await svc.create(workspaceId, request.userId, input);
    return reply.code(201).send(pipeline);
  });

  app.post("/pipelines/:id/stages", async (request, reply) => {
    requireRole(request, ["owner", "admin", "member"]);
    await shadowCrmManage(request, "add pipeline stage");
    const id = parseIdParam(request);
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const input = pipelineStageCreateSchema.parse(request.body);
    const stage = await svc.addStage(workspaceId, id, input, request.userId);
    return reply.code(201).send(stage);
  });

  app.patch("/pipelines/:id", async (request, reply) => {
    requireRole(request, ["owner", "admin", "member"]);
    await shadowCrmManage(request, "update pipeline");
    const id = parseIdParam(request);
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const input = pipelineUpdateSchema.parse(request.body);
    const pipeline = await svc.update(workspaceId, id, request.userId, input);
    if (!pipeline) throw new HttpError("pipeline_not_found", 404);
    return reply.send(pipeline);
  });

  app.delete("/pipelines/:id", async (request, reply) => {
    const id = parseIdParam(request);
    const workspaceId = request.workspaceId ?? "unknown";
    requireRole(request, ["owner", "admin"]);
    await shadowCrmManage(request, "delete pipeline");
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const deleted = await svc.softDelete(workspaceId, id, request.userId);
    if (!deleted) throw new HttpError("pipeline_not_found", 404);
    return reply.code(204).send();
  });
}
