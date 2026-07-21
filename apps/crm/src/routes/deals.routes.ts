import type { FastifyInstance } from "fastify";
import { dealCreateSchema, dealListQuerySchema, dealUpdateSchema } from "@skout/shared";
import { HttpError } from "@skout/auth";
import { parseIdParam } from "../utils/http.js";
import { requireRole } from "../utils/require-role.js";
import { buildActivitiesService } from "../services/activities.service.js";
import { buildAuditService } from "../services/audit.service.js";
import { buildCompaniesService } from "../services/companies.service.js";
import { buildDealsService } from "../services/deals.service.js";
import { buildPipelinesService } from "../services/pipelines.service.js";

export async function dealsRoutes(app: FastifyInstance) {
  const service = () => {
    const db = app.db ?? null;
    const auditService = buildAuditService(db);
    const companiesService = buildCompaniesService(db, auditService);
    const pipelinesService = buildPipelinesService(db, auditService);
    const activitiesService = buildActivitiesService(db);
    return buildDealsService(db, companiesService, pipelinesService, activitiesService, auditService);
  };

  // Registered before "/deals/:id" so the literal path takes precedence.
  app.get("/deals/summary", async (request) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) {
      return { workspaceId, openDeals: 0, pipelineValue: 0, currency: "USD", stages: [] };
    }
    return svc.summary(workspaceId);
  });

  app.get("/deals", async (request) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) return { data: [], total: 0, workspaceId };

    const query = dealListQuerySchema.parse(request.query);
    const result = await svc.list(workspaceId, query);
    return { ...result, workspaceId };
  });

  app.post("/deals", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const input = dealCreateSchema.parse(request.body);
    const deal = await svc.create(workspaceId, request.userId, input);
    return reply.code(201).send(deal);
  });

  app.get("/deals/:id", async (request, reply) => {
    const id = parseIdParam(request);
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const deal = await svc.getById(workspaceId, id);
    if (!deal) throw new HttpError("deal_not_found", 404);
    return reply.send(deal);
  });

  app.patch("/deals/:id", async (request, reply) => {
    const id = parseIdParam(request);
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const input = dealUpdateSchema.parse(request.body);
    const deal = await svc.update(workspaceId, id, input, request.userId);
    if (!deal) throw new HttpError("deal_not_found", 404);
    return reply.send(deal);
  });

  app.delete("/deals/:id", async (request, reply) => {
    const id = parseIdParam(request);
    const workspaceId = request.workspaceId ?? "unknown";
    requireRole(request, ["owner", "admin"]);
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const deleted = await svc.softDelete(workspaceId, id, request.userId);
    if (!deleted) throw new HttpError("deal_not_found", 404);
    return reply.code(204).send();
  });
}
