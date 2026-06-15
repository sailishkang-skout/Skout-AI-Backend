import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { OpenSearchConfig } from "@skout/opensearch";
import { buildEnrichmentService } from "../services/enrichment/index.js";
import { prospectToSnapshot, prospectToSummary } from "../services/smart-list.mapper.js";
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

const activateSchema = z.object({
  listName: z.string().min(1).max(255).optional(),
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

function formatRunResponse(result: NonNullable<Awaited<ReturnType<typeof runSmartList>>>) {
  const hits = result.hits.map(prospectToSummary);
  return {
    list: result.list,
    hits,
    total: result.total,
    demo: result.demo,
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
    const result = await runSmartList(app.db, osConfig(app), workspaceId, id);
    if (!result) return reply.status(404).send({ error: "smart_list_not_found" });
    return reply.send(formatRunResponse(result));
  });

  /** Run smart list, activate all matches, and create a workspace prospect list. */
  app.post("/smart-lists/:id/activate", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const body = activateSchema.parse(request.body ?? {});

    const result = await runSmartList(app.db, osConfig(app), workspaceId, id);
    if (!result) return reply.status(404).send({ error: "smart_list_not_found" });

    const prospects = result.hits.map(prospectToSnapshot).filter((p) => p.companyDomain);
    if (prospects.length === 0) {
      return reply.status(422).send({
        error: "no_matches",
        message: "Smart list matched 0 prospects — adjust filters and try again.",
      });
    }

    const svc = buildEnrichmentService(app.db, app.config);
    const listName =
      body.listName ?? `${result.list.name} — ${new Date().toISOString().slice(0, 10)}`;
    const list = await svc.createList(workspaceId, listName, prospects);

    return reply.status(201).send({
      list,
      smartList: result.list,
      hits: result.hits.map(prospectToSummary),
      total: result.total,
      activated: prospects.length,
      demo: result.demo,
    });
  });
}
