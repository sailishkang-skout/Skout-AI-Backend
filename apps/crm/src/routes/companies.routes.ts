import type { FastifyInstance } from "fastify";
import {
  companyAutoFillSchema,
  companyCreateSchema,
  companyListQuerySchema,
  companyUpdateSchema,
} from "@skout/shared";
import { HttpError, enforcePermission } from "@skout/auth";
import { parseIdParam } from "../utils/http.js";
import { requireRole } from "../utils/require-role.js";
import { buildAuditService } from "../services/audit.service.js";
import { buildCompaniesService } from "../services/companies.service.js";

export async function companiesRoutes(app: FastifyInstance) {
  const service = () => {
    const db = app.db ?? null;
    const auditService = buildAuditService(db);
    return buildCompaniesService(db, auditService);
  };

  app.get("/companies", async (request) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const query = companyListQuerySchema.parse(request.query);
    const result = await svc.list(workspaceId, query);
    return { ...result, workspaceId };
  });

  app.post("/companies", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const input = companyCreateSchema.parse(request.body);
    const company = await svc.create(workspaceId, request.userId, input);
    return reply.code(201).send(company);
  });

  app.get("/companies/:id", async (request, reply) => {
    const id = parseIdParam(request);
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const company = await svc.getById(workspaceId, id);
    if (!company) throw new HttpError("company_not_found", 404);
    return reply.send(company);
  });

  app.patch("/companies/:id", async (request, reply) => {
    const id = parseIdParam(request);
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const input = companyUpdateSchema.parse(request.body);
    const company = await svc.update(workspaceId, id, request.userId, input);
    if (!company) throw new HttpError("company_not_found", 404);
    return reply.send(company);
  });

  /** R13.3 — auto-fill fields from enrichment; manual edits always win. */
  app.post("/companies/:id/auto-fill", async (request, reply) => {
    const id = parseIdParam(request);
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const input = companyAutoFillSchema.parse(request.body);
    const result = await svc.autoFill(workspaceId, id, input.patch, input.source, input.confidence);
    if (!result) throw new HttpError("company_not_found", 404);
    return reply.send(result);
  });

  app.delete("/companies/:id", async (request, reply) => {
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
          app.log.warn(info, "RBAC shadow-mode: crm:manage would have been denied (delete company)"),
      });
    }

    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const deleted = await svc.softDelete(workspaceId, id, request.userId);
    if (!deleted) throw new HttpError("company_not_found", 404);
    return reply.code(204).send();
  });
}
