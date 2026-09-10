import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { searchFiltersSchema } from "@skout/shared";
import { buildEnrichmentService, InsufficientCreditsError } from "../services/enrichment/index.js";
import { prospectToSnapshot, prospectToSummary } from "../services/smart-list.mapper.js";
import { createSearchCacheService } from "../services/search-cache.service.js";
import { buildListService } from "../services/list.service.js";
import {
  createSmartList,
  deleteSmartList,
  getSmartListRefresh,
  listSmartListRefreshes,
  listSmartLists,
  osConfigFromEnv,
  revertSmartListRefresh,
  runSmartList,
  updateSmartList,
  updateSmartListRefreshSchedule,
} from "../services/smart-list.service.js";
import { CADENCE_VALUES } from "../services/smart-list-cadence.js";
import { HttpError, errorResponse, requireWorkspaceId } from "../utils/http.js";

const createSchema = z.object({
  name: z.string().min(1).max(255),
  filters: searchFiltersSchema,
});

const updateSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    filters: searchFiltersSchema.optional(),
  })
  .refine((v) => v.name !== undefined || v.filters !== undefined, {
    message: "Provide name or filters to update",
  });

const activateSchema = z.object({
  listName: z.string().min(1).max(255).optional(),
  listId: z.string().uuid().optional(),
});

const refreshScheduleSchema = z.object({
  cadence: z.enum(CADENCE_VALUES),
});

function osConfig(app: FastifyInstance) {
  return osConfigFromEnv(app.config);
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
    const workspaceId = requireWorkspaceId(request);
    const data = await listSmartLists(app.db, workspaceId);
    return reply.send({ workspaceId, data, total: data.length });
  });

  app.post("/smart-lists", async (request, reply) => {
    const workspaceId = requireWorkspaceId(request);
    const body = createSchema.parse(request.body ?? {});
    const list = await createSmartList(app.db, workspaceId, body.name, body.filters);
    return reply.status(201).send(list);
  });

  app.patch("/smart-lists/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = requireWorkspaceId(request);
    const body = updateSchema.parse(request.body ?? {});
    const updated = await updateSmartList(app.db, workspaceId, id, body);
    if (!updated) return reply.status(404).send({ error: "smart_list_not_found" });
    await createSearchCacheService(app.config).invalidateSmartList(workspaceId, id);
    return reply.send(updated);
  });

  /** Configure the auto-refresh cadence (R10.2): "off" | "daily" | "weekly". */
  app.patch("/smart-lists/:id/refresh-schedule", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = requireWorkspaceId(request);
    const body = refreshScheduleSchema.parse(request.body ?? {});
    const updated = await updateSmartListRefreshSchedule(app.db, workspaceId, id, body.cadence);
    if (!updated) return reply.status(404).send({ error: "smart_list_not_found" });
    return reply.send(updated);
  });

  /** Paginated auto-refresh history, each entry including its full added/dropped diff. */
  app.get("/smart-lists/:id/refreshes", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = requireWorkspaceId(request);
    const { limit } = request.query as { limit?: string };
    const parsedLimit = limit ? Number(limit) : 20;
    const data = await listSmartListRefreshes(
      app.db,
      workspaceId,
      id,
      Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 100) : 20
    );
    return reply.send({ workspaceId, smartListId: id, data, total: data.length });
  });

  /** Full diff (added/dropped prospects) for a single refresh. */
  app.get("/smart-lists/:id/refreshes/:refreshId", async (request, reply) => {
    const { id, refreshId } = request.params as { id: string; refreshId: string };
    const workspaceId = requireWorkspaceId(request);
    const detail = await getSmartListRefresh(app.db, workspaceId, id, refreshId);
    if (!detail) return reply.status(404).send({ error: "smart_list_refresh_not_found" });
    return reply.send(detail);
  });

  /** One-click revert of a refresh's membership change (only the most recent refresh qualifies). */
  app.post("/smart-lists/:id/refreshes/:refreshId/revert", async (request, reply) => {
    const { id, refreshId } = request.params as { id: string; refreshId: string };
    const workspaceId = requireWorkspaceId(request);
    try {
      const reverted = await revertSmartListRefresh(app.db, workspaceId, id, refreshId);
      if (!reverted) return reply.status(404).send({ error: "smart_list_refresh_not_found" });
      await createSearchCacheService(app.config).invalidateSmartList(workspaceId, id);
      return reply.send(reverted);
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send(errorResponse(err.message, err.statusCode));
      }
      throw err;
    }
  });

  app.delete("/smart-lists/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = requireWorkspaceId(request);
    const deleted = await deleteSmartList(app.db, workspaceId, id);
    if (!deleted) return reply.status(404).send({ error: "smart_list_not_found" });
    await createSearchCacheService(app.config).invalidateSmartList(workspaceId, id);
    return reply.status(204).send();
  });

  app.post("/smart-lists/:id/run", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = requireWorkspaceId(request);
    const cache = createSearchCacheService(app.config);

    const cached = await cache.getSmartList(workspaceId, id);
    if (cached) return reply.send(cached);

    const result = await runSmartList(app.db, osConfig(app), workspaceId, id);
    if (!result) return reply.status(404).send({ error: "smart_list_not_found" });
    const payload = formatRunResponse(result);
    await cache.setSmartList(workspaceId, id, payload as Record<string, unknown>);
    return reply.send(payload);
  });

  /** Run smart list, activate all matches, and create a workspace prospect list. */
  app.post("/smart-lists/:id/activate", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = requireWorkspaceId(request);
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

    let list: Awaited<ReturnType<typeof svc.createList>>;
    if (body.listId) {
      const updated = await svc.addListMembers(workspaceId, body.listId, prospects);
      if (!updated) return reply.status(404).send({ error: "list_not_found" });
      list = updated;
    } else {
      const listName =
        body.listName ?? `${result.list.name} — ${new Date().toISOString().slice(0, 10)}`;
      list = await svc.createList(workspaceId, listName, prospects);
      // R10.3 — a brand-new list from activation has known-reconstructable filters (this smart
      // list's), unlike a list you're merely adding matches into, so only tag this branch.
      const listSvc = buildListService(app.db, osConfig(app));
      await listSvc?.setSourceFilters(workspaceId, list.id, result.list.filters);
    }

    return reply.status(201).send({
      list,
      smartList: result.list,
      hits: result.hits.map(prospectToSummary),
      total: result.total,
      activated: prospects.length,
      demo: result.demo,
    });
  });

  /** Batch re-score all prospects matched by a smart list (corpus scope). */
  app.post("/smart-lists/:id/score", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = requireWorkspaceId(request);
    const result = await runSmartList(app.db, osConfig(app), workspaceId, id);
    if (!result) return reply.status(404).send({ error: "smart_list_not_found" });

    const svc = buildEnrichmentService(app.db, app.config);
    const snapshots = result.hits.map(prospectToSnapshot).filter((p) => p.companyDomain);
    try {
      const scored = await svc.runCorpusScore(workspaceId, snapshots);
      return reply.send({
        smartList: result.list,
        total: result.total,
        demo: result.demo,
        ...scored,
      });
    } catch (err) {
      if (err instanceof InsufficientCreditsError) {
        return reply.status(402).send({
          error: "insufficient_credits",
          required: err.required,
          available: err.available,
        });
      }
      throw err;
    }
  });
}
