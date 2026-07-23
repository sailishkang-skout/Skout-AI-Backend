import type { FastifyInstance } from "fastify";
import { contactCreateSchema, contactListQuerySchema, contactUpdateSchema } from "@skout/shared";
import { HttpError } from "@skout/auth";
import { parseIdParam } from "../utils/http.js";
import { requireRole } from "../utils/require-role.js";
import { buildCompaniesService } from "../services/companies.service.js";
import { buildContactsService } from "../services/contacts.service.js";

export async function contactsRoutes(app: FastifyInstance) {
  const service = () => {
    const companiesService = buildCompaniesService(app.db ?? null);
    return buildContactsService(app.db ?? null, companiesService);
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
    const contact = await svc.create(workspaceId, input);
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
    const contact = await svc.update(workspaceId, id, input);
    if (!contact) throw new HttpError("contact_not_found", 404);
    return reply.send(contact);
  });

  app.delete("/contacts/:id", async (request, reply) => {
    const id = parseIdParam(request);
    const workspaceId = request.workspaceId ?? "unknown";
    requireRole(request, ["owner", "admin"]);
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const deleted = await svc.softDelete(workspaceId, id);
    if (!deleted) throw new HttpError("contact_not_found", 404);
    return reply.code(204).send();
  });
}
