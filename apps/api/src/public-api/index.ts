import type { FastifyInstance } from "fastify";
import { getRedis, isRedisAvailable } from "../lib/redis.js";
import { createMemoryQuotaStore, createRedisQuotaStore } from "../lib/api-quota.js";
import { ApiPricingService } from "../services/api-pricing.service.js";
import { PUBLIC_API_PREFIX } from "../routes/public-api.routes.js";
import { publicApiPlugin } from "./plugin.js";
import type { PublicApiDeps, PublicEndpoint } from "./pipeline.js";

/** The public API's endpoints (Phase 5 adds them here). */
export const PUBLIC_API_ENDPOINTS: PublicEndpoint[] = [];

/** Registers the public API at /api/public/v1 with the app's database, Redis and config (PAPI-040). */
export async function registerPublicApi(app: FastifyInstance, endpoints: PublicEndpoint[] = PUBLIC_API_ENDPOINTS) {
  if (!app.db) {
    // Without a database only the health check can answer.
    await app.register(async (pub) => {
      pub.get("/health", async () => ({ status: "ok", service: "skout-public-api", version: "v1" }));
    }, { prefix: PUBLIC_API_PREFIX });
    return;
  }
  const redis = app.config.REDIS_URL && (await isRedisAvailable(app.config)) ? getRedis(app.config) : null;
  const deps: PublicApiDeps = {
    db: app.db,
    pricing: new ApiPricingService(app.db, { INTERNAL_WORKSPACE_ID: app.config.INTERNAL_WORKSPACE_ID, searchCreditCost: app.config.SEARCH_CREDIT_COST }),
    quotas: redis ? createRedisQuotaStore(redis) : createMemoryQuotaStore(),
    limitDefaults: {
      verifyDailyQuota: app.config.PUBLIC_API_VERIFY_DAILY_QUOTA,
      searchDailyQuota: app.config.PUBLIC_API_SEARCH_DAILY_QUOTA,
    },
    enabled: app.config.PUBLIC_API_ENABLED === "true",
  };
  await app.register(publicApiPlugin, { prefix: PUBLIC_API_PREFIX, deps, endpoints });
}
