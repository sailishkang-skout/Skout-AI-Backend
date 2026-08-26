import type { FastifyInstance } from "fastify";
import { searchProspectsRequestSchema } from "@skout/shared";
import { getStore, InsufficientCreditsError } from "../services/enrichment/index.js";
import { buildDetailFromSnapshot, createSearchService } from "../services/search.service.js";
import { buildEntitlementsService } from "../services/entitlements.service.js";
import {
  buildSearchCacheKey,
  createSearchCacheService,
} from "../services/search-cache.service.js";
import { mergeTranslatedFilters, translateNaturalLanguageQuery } from "../services/nl-search.service.js";
import { apiError, HttpError } from "../utils/http.js";

export async function searchRoutes(app: FastifyInstance) {
  app.post("/search/prospects", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    let body = searchProspectsRequestSchema.parse(request.body ?? {});

    // 8.2 — one query model: free text is translated into the same structured SearchFilters
    // shape, merged under any filters the caller already set explicitly, rather than running
    // as a second, separate search path.
    let nlMethod: "llm" | "heuristic" | null = null;
    let nlUnverified = false;
    if (body.query && body.query.trim()) {
      const { filters: translated, method, unverified } = await translateNaturalLanguageQuery(body.query, {
        openrouterApiKey: app.config.OPENROUTER_API_KEY,
      });
      nlMethod = method;
      nlUnverified = unverified;
      body = { ...body, filters: mergeTranslatedFilters(body.filters ?? {}, translated) };
    }

    app.log.info({ parsedFilters: body.filters, query: body.query, nlMethod, workspaceId }, "search parsed");

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
    // §5.1 Task 35 — deductCredits() itself is completely unchanged; only which number gets
    // passed to it can now vary per workspace. entitlements.service.ts's getValueOr() never
    // throws, so a lookup failure resolves to the existing global config value, never blocking
    // a search. A workspace with no "search.credit_cost" entitlement pays exactly what it did
    // before this commit.
    const entitlementsSvc = app.db ? buildEntitlementsService(app.db) : null;
    const creditCost = entitlementsSvc
      ? await entitlementsSvc.getValueOr<number>(workspaceId, "search.credit_cost", app.config.SEARCH_CREDIT_COST)
      : app.config.SEARCH_CREDIT_COST;
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
    let result;
    try {
      result = await svc.searchProspects(body);
    } catch (err) {
      if (err instanceof HttpError) {
        return reply
          .code(err.statusCode)
          .send(apiError(err.message, err.message, err.statusCode));
      }
      throw err;
    }
    const payload = {
      results: result.results,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      ...("source" in result && result.source ? { source: result.source } : {}),
    };

    await cache.set(cacheKey, payload);

    return reply.send({
      ...payload,
      cached: false,
      creditsUsed: creditCost,
      ...(nlMethod ? { nlMethod, nlUnverified } : {}),
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
    const [activation, scoreRow] = await Promise.all([
      store.getActivation(workspaceId, id).catch(() => null),
      store.getScore(workspaceId, id).catch(() => null),
    ]);
    const scoreFields = scoreRow
      ? {
          painPoints: scoreRow.painPoints,
          painPointsRationale: scoreRow.painPointsRationale ?? undefined,
          icpScore: scoreRow.score,
          outreachReadiness: scoreRow.priority ?? undefined,
        }
      : {};
    if (activation && activation.snapshot && Object.keys(activation.snapshot).length > 0) {
      const osDoc = await svc.findExistingProspect(id);
      const fromSnapshot = buildDetailFromSnapshot(
        id,
        activation.companyId ?? id,
        activation.snapshot as Record<string, unknown>,
        activation.updatedAt
      );
      // Snapshot fields win; backfill blanks from the corpus doc; score fields always included.
      return reply.send({ ...(osDoc ?? {}), ...stripEmpty(fromSnapshot), ...scoreFields });
    }

    const result = await svc.getProspectById(id);
    if (!result) {
      return reply.status(404).send({ error: "prospect_not_found" });
    }
    const merged = { ...(result as Record<string, unknown>), ...scoreFields };
    await cache.setById(workspaceId, id, merged);
    return reply.send(merged);
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
