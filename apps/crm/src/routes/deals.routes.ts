import type { FastifyInstance } from "fastify";
import { dealCreateSchema, dealListQuerySchema, dealUpdateSchema } from "@skout/shared";
import { HttpError, enforcePermission } from "@skout/auth";
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
      return { workspaceId, openDeals: 0, valueByCurrency: [], stages: [] };
    }
    return svc.summary(workspaceId);
  });

  app.get("/deals", async (request) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

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

    // §5.1 / §11.1 — fine-grained RBAC shadow check alongside the role gate above. requireRole()
    // is what actually enforces access today (unchanged); this is shadow-mode by default
    // (RBAC_ENFORCEMENT_ENABLED unset) — see enforcePermission's own doc comment for why
    // enforcing before backfill-rbac.ts has run would deny every request outright.
    if (app.db && request.userId) {
      await enforcePermission(app.db, workspaceId, request.userId, "crm:manage", {
        enforce: app.config.RBAC_ENFORCEMENT_ENABLED,
        onShadowDeny: (info) =>
          app.log.warn(info, "RBAC shadow-mode: crm:manage would have been denied (delete deal)"),
      });
    }

    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const deleted = await svc.softDelete(workspaceId, id, request.userId);
    if (!deleted) throw new HttpError("deal_not_found", 404);
    return reply.code(204).send();
  });
}
