import type { FastifyInstance } from "fastify";
import {
  contactAutoFillSchema,
  contactCreateSchema,
  contactListQuerySchema,
  contactUpdateSchema,
} from "@skout/shared";
import { HttpError } from "@skout/auth";
import { parseIdParam } from "../utils/http.js";
import { requireRole } from "../utils/require-role.js";
import { buildAuditService } from "../services/audit.service.js";
import { buildCompaniesService } from "../services/companies.service.js";
import { buildContactsService } from "../services/contacts.service.js";

export async function contactsRoutes(app: FastifyInstance) {
  const service = () => {
    const db = app.db ?? null;
    const auditService = buildAuditService(db);
    const companiesService = buildCompaniesService(db, auditService);
    return buildContactsService(db, companiesService, auditService);
  };

  app.get("/contacts", async (request) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const query = contactListQuerySchema.parse(request.query);
    const result = await svc.list(workspaceId, query);
    return { ...result, workspaceId };
  });

  app.post("/contacts", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const input = contactCreateSchema.parse(request.body);
    const contact = await svc.create(workspaceId, request.userId, input);
    return reply.code(201).send(contact);
  });

  app.get("/contacts/:id", async (request, reply) => {
    const id = parseIdParam(request);
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const contact = await svc.getById(workspaceId, id);
    if (!contact) throw new HttpError("contact_not_found", 404);
    return reply.send(contact);
  });

  app.patch("/contacts/:id", async (request, reply) => {
    const id = parseIdParam(request);
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const input = contactUpdateSchema.parse(request.body);
    const contact = await svc.update(workspaceId, id, request.userId, input);
    if (!contact) throw new HttpError("contact_not_found", 404);
    return reply.send(contact);
  });

  /** R13.3 — auto-fill fields from enrichment/meeting-notes/call-notes; manual edits always win. */
  app.post("/contacts/:id/auto-fill", async (request, reply) => {
    const id = parseIdParam(request);
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const input = contactAutoFillSchema.parse(request.body);
    const result = await svc.autoFill(workspaceId, id, input.patch, input.source, input.confidence);
    if (!result) throw new HttpError("contact_not_found", 404);
    return reply.send(result);
  });

  app.delete("/contacts/:id", async (request, reply) => {
    const id = parseIdParam(request);
    const workspaceId = request.workspaceId ?? "unknown";
    requireRole(request, ["owner", "admin"]);
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const deleted = await svc.softDelete(workspaceId, id, request.userId);
    if (!deleted) throw new HttpError("contact_not_found", 404);
    return reply.code(204).send();
  });
}
