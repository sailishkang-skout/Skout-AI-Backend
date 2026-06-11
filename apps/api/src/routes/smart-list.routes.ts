import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { OpenSearchConfig } from "@skout/opensearch";
import {
  createSmartList,
  listSmartLists,
  runSmartList,
} from "../services/smart-list.service.js";

const createSchema = z.object({
  name: z.string().min(1).max(255),
  filters: z.object({
    query: z.string().optional(),
    industry: z.string().optional(),
    country: z.string().optional(),
    seniority: z.string().optional(),
    minEmployees: z.number().optional(),
    maxEmployees: z.number().optional(),
    tech: z.string().optional(),
    signal: z.string().optional(),
  }),
});

function osConfig(app: FastifyInstance): OpenSearchConfig | null {
  if (!app.config.OPENSEARCH_URL) return null;
  return {
    url: app.config.OPENSEARCH_URL,
    username: app.config.OPENSEARCH_USERNAME,
    password: app.config.OPENSEARCH_PASSWORD,
    index: app.config.OPENSEARCH_INDEX,
  };
}

export async function smartListRoutes(app: FastifyInstance) {
  app.get("/smart-lists", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const data = await listSmartLists(app.db, workspaceId);
    return reply.send({ workspaceId, data, total: data.length });
  });

  app.post("/smart-lists", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const body = createSchema.parse(request.body ?? {});
    const list = await createSmartList(app.db, workspaceId, body.name, body.filters);
    return reply.status(201).send(list);
  });

  app.post("/smart-lists/:id/run", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const cfg = osConfig(app);
    if (!cfg) return reply.status(503).send({ error: "opensearch_not_configured" });
    const result = await runSmartList(app.db, cfg, workspaceId, id);
    if (!result) return reply.status(404).send({ error: "smart_list_not_found" });
    return reply.send(result);
  });
}
