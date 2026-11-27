import type { Redis } from "ioredis";

/**
 * PAPI-025 (public API PRD RL-3): at most N failed authentications per IP per minute on
 * /api/public/*. Reaching N blocks that IP on the public path for M minutes, which slows key
 * guessing down without touching the website or the app.
 */
export interface FailedAuthLimiter {
  /** Seconds left on the IP's block, or 0 when it isn't blocked. */
  blockedFor(ip: string): Promise<number>;
  /** Counts one failed authentication; blocks the IP once it reaches the per-minute limit. */
  recordFailure(ip: string): Promise<void>;
}

export interface FailedAuthLimits {
  perMinute: number;
  blockMinutes: number;
}

const COUNT_PREFIX = "papi:authfail:";
const BLOCK_PREFIX = "papi:authblock:";

/** Shared across all API instances (RL-1). */
export function createRedisFailedAuthLimiter(redis: Redis, limits: FailedAuthLimits): FailedAuthLimiter {
  return {
    async blockedFor(ip) {
      const ttl = await redis.ttl(BLOCK_PREFIX + ip);
      return ttl > 0 ? ttl : 0;
    },
    async recordFailure(ip) {
      const countKey = COUNT_PREFIX + ip;
      const [[, count]] = (await redis.multi().incr(countKey).expire(countKey, 60, "NX").exec()) as [[unknown, number], unknown];
      if (count >= limits.perMinute) {
        await redis.set(BLOCK_PREFIX + ip, "1", "EX", limits.blockMinutes * 60);
        await redis.del(countKey);
      }
    },
  };
}

/** Per-process fallback when Redis isn't available (local dev, CI). */
export function createMemoryFailedAuthLimiter(limits: FailedAuthLimits, clock: () => number = Date.now): FailedAuthLimiter {
  const counts = new Map<string, { n: number; resetAt: number }>();
  const blocks = new Map<string, number>();
  return {
    async blockedFor(ip) {
      const until = blocks.get(ip);
      if (!until) return 0;
      const left = until - clock();
      if (left <= 0) {
        blocks.delete(ip);
        return 0;
      }
      return Math.ceil(left / 1000);
    },
    async recordFailure(ip) {
      const now = clock();
      const c = counts.get(ip);
      const entry = c && c.resetAt > now ? c : { n: 0, resetAt: now + 60_000 };
      entry.n += 1;
      counts.set(ip, entry);
      if (entry.n >= limits.perMinute) {
        blocks.set(ip, now + limits.blockMinutes * 60_000);
        counts.delete(ip);
      }
      if (counts.size > 50_000) {
        for (const [k, v] of counts) if (v.resetAt <= now) counts.delete(k);
      }
    },
  };
}
