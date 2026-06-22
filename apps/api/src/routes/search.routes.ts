import type { FastifyInstance } from "fastify";
import { searchProspectsRequestSchema } from "@skout/shared";
import { getStore, InsufficientCreditsError } from "../services/enrichment/index.js";
import { createSearchService } from "../services/search.service.js";
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
    const svc = createSearchService(app.config);
    const result = await svc.getProspectById(id);
    return reply.send(result);
  });
}
