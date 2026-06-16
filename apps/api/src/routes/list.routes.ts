import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { buildEnrichmentService } from "../services/enrichment/index.js";
import { HttpError, errorResponse } from "../utils/http.js";

const snapshotSchema = z.object({
  prospectId: z.string().optional(),
  companyId: z.string().optional(),
  fullName: z.string().optional(),
  title: z.string().optional(),
  seniority: z.string().optional(),
  industry: z.string().optional(),
  country: z.string().optional(),
  companyDomain: z.string().min(1),
  email: z.string().email().optional(),
  employeeCount: z.number().optional(),
});

const createListSchema = z.object({
  name: z.string().min(1).max(255),
  prospects: z.array(snapshotSchema).optional(),
});

const enrichListSchema = z.object({
  fields: z.array(z.enum(["company", "email", "validation", "phone"])).optional(),
});

export async function listRoutes(app: FastifyInstance) {
  app.get("/lists", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildEnrichmentService(app.db, app.config);
    const data = await svc.listLists(workspaceId);
    return reply.send({ workspaceId, data, total: data.length });
  });

  app.post("/lists", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const body = createListSchema.parse(request.body ?? {});
    const svc = buildEnrichmentService(app.db, app.config);
    const list = await svc.createList(workspaceId, body.name, body.prospects ?? []);
    return reply.status(201).send(list);
  });

  app.get("/lists/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildEnrichmentService(app.db, app.config);
    const detail = await svc.getListDetail(workspaceId, id);
    if (!detail) return reply.status(404).send({ error: "list_not_found" });
    return reply.send(detail);
  });

  app.post("/lists/:id/score", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildEnrichmentService(app.db, app.config);
    try {
      const result = await svc.scoreList(workspaceId, id);
      return reply.send(result);
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send(errorResponse(err.message, err.statusCode));
      }
      throw err;
    }
  });

  app.post("/lists/:id/enrich", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const body = enrichListSchema.parse(request.body ?? {});
    const svc = buildEnrichmentService(app.db, app.config);
    const batch = await svc.enrichList(workspaceId, id, { fields: body.fields });
    return reply.status(202).send({ batchId: batch.id, status: batch.status, total: batch.total });
  });

  app.post("/lists/:id/members", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const body = z.object({ prospects: z.array(snapshotSchema).min(1) }).parse(request.body ?? {});
    const svc = buildEnrichmentService(app.db, app.config);
    const list = await svc.addListMembers(workspaceId, id, body.prospects);
    if (!list) return reply.status(404).send({ error: "list_not_found" });
    return reply.status(200).send(list);
  });
}
