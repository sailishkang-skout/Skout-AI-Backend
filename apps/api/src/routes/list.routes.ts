import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { OpenSearchConfig } from "@skout/opensearch";
import { buildEnrichmentService } from "../services/enrichment/index.js";
import { createCrmService } from "../services/crm.service.js";
import { HttpError, errorResponse } from "../utils/http.js";
import { buildListService } from "../services/list.service.js";
import type { Env } from "../config/env.js";

function osConfig(config: Env): OpenSearchConfig | null {
  if (!config.OPENSEARCH_URL) return null;
  return {
    url: config.OPENSEARCH_URL,
    username: config.OPENSEARCH_USERNAME,
    password: config.OPENSEARCH_PASSWORD,
    index: config.OPENSEARCH_INDEX,
  };
}

const enrichListSchema = z.object({
  fields: z.array(z.enum(["company", "email", "validation", "phone"])).optional(),
});

export async function listRoutes(app: FastifyInstance) {
  app.get("/lists", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildListService(app.db, osConfig(app.config));
    if (!svc) return reply.send({ workspaceId, data: [], total: 0 });
    const data = await svc.getLists(workspaceId);
    return reply.send({ workspaceId, data, total: data.length });
  });

  app.post("/lists", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const { name } = z.object({ name: z.string().min(1).max(255) }).parse(request.body ?? {});
    const svc = buildListService(app.db, osConfig(app.config));
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const list = await svc.createList(workspaceId, name);
    return reply.status(201).send(list);
  });

  app.get("/lists/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildListService(app.db, osConfig(app.config));
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const list = await svc.getListById(workspaceId, id);
    if (!list) return reply.status(404).send({ error: "list_not_found" });
    return reply.send(list);
  });

  app.get("/lists/:id/members", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildListService(app.db, osConfig(app.config));
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const members = await svc.getMembers(workspaceId, id);
    if (members === null) return reply.status(404).send({ error: "list_not_found" });
    return reply.send(members);
  });

  app.post("/lists/:id/members", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const { prospectIds } = z
      .object({ prospectIds: z.array(z.string().min(1)).min(1) })
      .parse(request.body ?? {});
    const svc = buildListService(app.db, osConfig(app.config));
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const list = await svc.addMembers(workspaceId, id, prospectIds);
    if (!list) return reply.status(404).send({ error: "list_not_found" });
    return reply.send(list);
  });

  app.post("/lists/:id/enrich", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const body = enrichListSchema.parse(request.body ?? {});
    const svc = buildEnrichmentService(app.db, app.config);
    const batch = await svc.enrichList(workspaceId, id, { fields: body.fields });
    return reply.status(202).send({ batchId: batch.id, status: batch.status, total: batch.total });
  });

  app.patch("/lists/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const body = z.object({ name: z.string().min(1).max(255) }).parse(request.body ?? {});
    const svc = buildEnrichmentService(app.db, app.config);
    const list = await svc.renameList(workspaceId, id, body.name);
    if (!list) return reply.status(404).send({ error: "list_not_found" });
    return reply.send(list);
  });

  app.delete("/lists/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildEnrichmentService(app.db, app.config);
    await svc.deleteList(workspaceId, id);
    return reply.status(204).send();
  });

  app.delete("/lists/:id/members", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const body = z.object({ prospectIds: z.array(z.string()).min(1) }).parse(request.body ?? {});
    const svc = buildEnrichmentService(app.db, app.config);
    const list = await svc.removeMembersFromList(workspaceId, id, body.prospectIds);
    if (!list) return reply.status(404).send({ error: "list_not_found" });
    return reply.send(list);
  });

  app.post("/lists/:id/export/hubspot", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const crm = createCrmService(app.db, app.config);
    try {
      const result = await crm.startHubSpotListExport(workspaceId, id);
      return reply.status(202).send(result);
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send(errorResponse(err.message, err.statusCode, err.details));
      }
      throw err;
    }
  });
}
