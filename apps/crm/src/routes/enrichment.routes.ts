import type { FastifyInstance } from "fastify";
import { HttpError, enforcePermission, recordPrivilegedAction } from "@skout/auth";
import { parseIdParam, requireWorkspaceId } from "../utils/http.js";
import { buildAuditService } from "../services/audit.service.js";
import { buildEnrichmentService } from "../services/enrichment.service.js";

export async function enrichmentRoutes(app: FastifyInstance) {
  const service = () => {
    const db = app.db ?? null;
    const auditService = buildAuditService(db);
    return buildEnrichmentService(db, auditService);
  };

  // GET /enrichment/people - List enriched people
  app.get("/enrichment/people", async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await enforcePermission(app.db, workspaceId, request.userId, "enrichment:read", { enforce: false });
    
    const svc = service();
    if (!svc) throw new HttpError("service_unavailable", 503);
    
    const result = await svc.listPeople(workspaceId);
    return { ...result, workspaceId };
  });

  // GET /enrichment/companies - List enriched companies
  app.get("/enrichment/companies", async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await enforcePermission(app.db, workspaceId, request.userId, "enrichment:read", { enforce: false });
    
    const svc = service();
    if (!svc) throw new HttpError("service_unavailable", 503);
    
    const result = await svc.listCompanies(workspaceId);
    return { ...result, workspaceId };
  });

  // GET /enrichment/job-changes - List detected job changes
  app.get("/enrichment/job-changes", async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await enforcePermission(app.db, workspaceId, request.userId, "enrichment:read", { enforce: false });
    
    const svc = service();
    if (!svc) throw new HttpError("service_unavailable", 503);
    
    const result = await svc.listJobChanges(workspaceId);
    return { ...result, workspaceId };
  });

  // GET /enrichment/capture - Capture interface for enrichment operations
  app.get("/enrichment/capture", async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await enforcePermission(app.db, workspaceId, request.userId, "enrichment:capture", { enforce: false });
    
    const svc = service();
    if (!svc) throw new HttpError("service_unavailable", 503);
    
    const credits = await svc.getCredits(workspaceId);
    return { credits, workspaceId };
  });

  // GET /enrichment/campaigns - List enrichment campaigns
  app.get("/enrichment/campaigns", async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await enforcePermission(app.db, workspaceId, request.userId, "enrichment:read", { enforce: false });
    
    const svc = service();
    if (!svc) throw new HttpError("service_unavailable", 503);
    
    const result = await svc.listCampaigns(workspaceId);
    return { ...result, workspaceId };
  });

  // POST /enrichment/export - Export enriched data (with audit logging)
  app.post("/enrichment/export", async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await enforcePermission(app.db, workspaceId, request.userId, "enrichment:export", { enforce: false });
    
    // Audit log the export operation
    await recordPrivilegedAction(app.db, {
      workspaceId,
      actorId: request.userId,
      action: "enrichment.export",
      entityType: "enrichment",
      entityId: "export-operation",
      beforeState: null,
      afterState: { timestamp: new Date().toISOString() }
    });
    
    const svc = service();
    if (!svc) throw new HttpError("service_unavailable", 503);
    
    const exportData = await svc.exportData(workspaceId, request.body);
    return reply.send(exportData);
  });

  // DELETE /enrichment/prospects/:id - Delete prospect (with audit logging)
  app.delete("/enrichment/prospects/:id", async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await enforcePermission(app.db, workspaceId, request.userId, "enrichment:delete", { enforce: false });
    
    const prospectId = parseIdParam({ params: request.params });
    
    // Audit log the delete operation
    await recordPrivilegedAction(app.db, {
      workspaceId,
      actorId: request.userId,
      action: "enrichment.delete",
      entityType: "prospect",
      entityId: prospectId,
      beforeState: null,
      afterState: { timestamp: new Date().toISOString() }
    });
    
    const svc = service();
    if (!svc) throw new HttpError("service_unavailable", 503);
    
    await svc.deleteProspect(workspaceId, prospectId);
    return { success: true, workspaceId };
  });
}