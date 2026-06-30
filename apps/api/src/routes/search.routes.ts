import type { FastifyInstance } from "fastify";
import { searchProspectsRequestSchema } from "@skout/shared";
import { getStore, InsufficientCreditsError } from "../services/enrichment/index.js";
import { buildDetailFromSnapshot, createSearchService } from "../services/search.service.js";
import {
  buildSearchCacheKey,
  createSearchCacheService,
} from "../services/search-cache.service.js";

export async function searchRoutes(app: FastifyInstance) {
  app.post("/search/prospects", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const body = searchProspectsRequestSchema.parse(request.body ?? {});
    app.log.info({ parsedFilters: body.filters, query: body.query, workspaceId }, "search parsed");

    const cache = createSearchCacheService(app.config);
    const cacheKey = buildSearchCacheKey(workspaceId, body);
    const cached = await cache.get(cacheKey);
    if (cached) {
      return reply.send({
        ...cached,
        cached: true,
        creditsUsed: 0,
      });
    }

    const store = getStore(app.db);
    const creditCost = app.config.SEARCH_CREDIT_COST;
    try {
      await store.deductCredits(workspaceId, creditCost, "search", cacheKey);
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

    const svc = createSearchService(app.config);
    const result = await svc.searchProspects(body);
    const payload = {
      results: result.results,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    };

    await cache.set(cacheKey, payload);

    return reply.send({
      ...payload,
      cached: false,
      creditsUsed: creditCost,
    });
  });

  app.get("/search/prospects/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const cache = createSearchCacheService(app.config);

    const cached = await cache.getById(workspaceId, id);
    if (cached) return reply.send(cached);

    const svc = createSearchService(app.config);

    // Prefer the workspace's own captured/activated data (e.g. LinkedIn extension)
    // over the OpenSearch corpus or the demo fallback.
    const store = getStore(app.db);
    const activation = await store.getActivation(workspaceId, id).catch(() => null);
    if (activation && activation.snapshot && Object.keys(activation.snapshot).length > 0) {
      const osDoc = await svc.findExistingProspect(id);
      const fromSnapshot = buildDetailFromSnapshot(
        id,
        activation.companyId ?? id,
        activation.snapshot as Record<string, unknown>,
        activation.updatedAt
      );
      // Snapshot fields win; backfill blanks from the corpus doc when present.
      return reply.send({ ...(osDoc ?? {}), ...stripEmpty(fromSnapshot) });
    }

    const result = await svc.getProspectById(id);
    await cache.setById(workspaceId, id, result as Record<string, unknown>);
    return reply.send(result);
  });
}

/** Drop empty-string/undefined values so they don't overwrite richer corpus fields. */
function stripEmpty<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = value;
  }
  return out as Partial<T>;
}
