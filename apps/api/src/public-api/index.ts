import type { FastifyInstance } from "fastify";
import type { Db } from "@skout/db";
import type { Env } from "../config/env.js";
import { createPeopleSearchEndpoint } from "./endpoints/people-search.js";
import { createGetPersonEndpoint, createMatchPersonEndpoint } from "./endpoints/people.js";
import { createCompanyJobsEndpoint, createGetCompanyEndpoint, createMatchCompanyEndpoint } from "./endpoints/companies.js";
import { createEmailFindEndpoint } from "./endpoints/contacts.js";
import { getRedis, isRedisAvailable } from "../lib/redis.js";
import { createMemoryQuotaStore, createRedisQuotaStore } from "../lib/api-quota.js";
import { ApiPricingService } from "../services/api-pricing.service.js";
import { PUBLIC_API_PREFIX } from "../routes/public-api.routes.js";
import { publicApiPlugin } from "./plugin.js";
import { randomBytes } from "node:crypto";
import { createPublicIdCodec, publicIdSecret } from "./ids.js";
import { createMemoryRateLimiter, createRedisRateLimiter } from "../lib/public-rate-limit.js";
import { createRateLimitStep } from "./rate-limit-step.js";
import { createRequestLogWriter } from "./request-log.js";
import type { PublicApiDeps, PublicEndpoint } from "./pipeline.js";

/** The public API's endpoints (Phase 5 adds them here). */
export function createPublicEndpoints(deps: { env: Env; db: Db }): PublicEndpoint[] {
  return [
    createPeopleSearchEndpoint(deps),
    createGetPersonEndpoint(deps),
    createMatchPersonEndpoint(deps),
    createMatchCompanyEndpoint(deps),
    createGetCompanyEndpoint(deps),
    createCompanyJobsEndpoint(deps),
    createEmailFindEndpoint(deps),
  ] as unknown as PublicEndpoint[];
}

/** Registers the public API at /api/public/v1 with the app's database, Redis and config (PAPI-040). */
export async function registerPublicApi(app: FastifyInstance) {
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
    // With the API on, API_KEY_PEPPER is required at boot, so a stable secret always exists. A
    // throwaway one is only used while the API is off and no pepper is configured.
    ids: createPublicIdCodec(publicIdSecret(app.config) ?? randomBytes(32).toString("base64")),
    logRequest: createRequestLogWriter(app.db),
    rateLimit: createRateLimitStep({
      limiter: redis ? createRedisRateLimiter(redis) : createMemoryRateLimiter(),
      base: {
        perSecond: app.config.PUBLIC_API_RATE_PER_SECOND,
        perMinute: app.config.PUBLIC_API_RATE_PER_MINUTE,
        batchPerMinute: app.config.PUBLIC_API_BATCH_RATE_PER_MINUTE,
      },
      db: app.db,
    }),
  };
  await app.register(publicApiPlugin, { prefix: PUBLIC_API_PREFIX, deps, endpoints: createPublicEndpoints({ env: app.config, db: app.db }) });
}
