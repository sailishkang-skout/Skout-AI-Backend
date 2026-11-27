import type { FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { ruleForTier, type PublicRateLimiter, type RateLimitRule } from "../lib/public-rate-limit.js";
import type { PublicEndpoint, RateLimitStepResult } from "./pipeline.js";

const TIER_CACHE_MS = 60_000;

/**
 * The pipeline's rate limit step (PAPI-041): counts the request against its API key's per-second and
 * per-minute windows (batch endpoints: the batch window), at the workspace's rate tier, and returns
 * the RateLimit-* headers for the response.
 */
export function createRateLimitStep(opts: { limiter: PublicRateLimiter; base: RateLimitRule; db: Db; clock?: () => Date }) {
  const tiers = new Map<string, { tier: string | null; at: number }>();
  const tierFor = async (workspaceId: string) => {
    const now = Date.now();
    const hit = tiers.get(workspaceId);
    if (hit && now - hit.at < TIER_CACHE_MS) return hit.tier;
    const [row] = await opts.db
      .select({ tier: schema.workspaceApiSettings.rateTier })
      .from(schema.workspaceApiSettings)
      .where(eq(schema.workspaceApiSettings.workspaceId, workspaceId))
      .limit(1);
    tiers.set(workspaceId, { tier: row?.tier ?? null, at: now });
    return row?.tier ?? null;
  };

  return async (request: FastifyRequest, endpoint: PublicEndpoint): Promise<RateLimitStepResult> => {
    const key = request.publicApiKey;
    if (!key) return { ok: true };
    const rule = ruleForTier(opts.base, await tierFor(key.workspaceId));
    const d = await opts.limiter.hit(key.id, { batch: Boolean(endpoint.batch), rule }, opts.clock?.());
    return {
      ok: d.ok,
      retryAfterSeconds: d.retryAfterSeconds,
      headers: {
        "ratelimit-limit": String(d.limit),
        "ratelimit-remaining": String(d.remaining),
        "ratelimit-reset": String(d.resetSeconds),
      },
    };
  };
}
