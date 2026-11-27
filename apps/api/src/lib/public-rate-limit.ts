import type { Redis } from "ioredis";

/**
 * Public API rate limits (PAPI-041, public API PRD RL-1, RL-2, RL-4, CONV-5): per API key, a
 * per-second burst limit and a per-minute limit (batch endpoints have their own, lower per-minute
 * limit). Fixed windows counted in Redis so every instance shares one counter; a per-process
 * fallback without Redis. Rate-limit refusals happen before any reservation, so they cost nothing.
 */
export interface RateLimitRule {
  perSecond: number;
  perMinute: number;
  batchPerMinute: number;
}

export interface RateDecision {
  ok: boolean;
  /** Values for the RateLimit-* headers (per-minute window). */
  limit: number;
  remaining: number;
  resetSeconds: number;
  /** Seconds until the window that refused the request resets. */
  retryAfterSeconds: number;
}

export interface PublicRateLimiter {
  hit(keyId: string, opts: { batch: boolean; rule: RateLimitRule }, now?: Date): Promise<RateDecision>;
}

/** CustomerOps rate tiers (workspace_api_settings.rate_tier): multipliers on the base limits. */
export const RATE_TIERS: Record<string, number> = { standard: 1, high: 5, enterprise: 20 };

export function ruleForTier(base: RateLimitRule, tier: string | null | undefined): RateLimitRule {
  const m = RATE_TIERS[tier ?? "standard"] ?? 1;
  return { perSecond: base.perSecond * m, perMinute: base.perMinute * m, batchPerMinute: base.batchPerMinute * m };
}

function windows(now: Date) {
  const ms = now.getTime();
  const second = Math.floor(ms / 1000);
  const minute = Math.floor(ms / 60_000);
  return { second, minute, minuteResetSeconds: Math.max(1, Math.ceil(((minute + 1) * 60_000 - ms) / 1000)) };
}

function decide(secCount: number, minCount: number, perSecond: number, perMinute: number, minuteResetSeconds: number): RateDecision {
  const overSecond = perSecond > 0 && secCount > perSecond;
  const overMinute = minCount > perMinute;
  return {
    ok: !overSecond && !overMinute,
    limit: perMinute,
    remaining: Math.max(0, perMinute - minCount),
    resetSeconds: minuteResetSeconds,
    retryAfterSeconds: overMinute ? minuteResetSeconds : 1,
  };
}

// KEYS: second counter, minute counter. Returns [secondCount, minuteCount].
const HIT = `
local s = redis.call('INCR', KEYS[1])
if s == 1 then redis.call('EXPIRE', KEYS[1], 2) end
local m = redis.call('INCR', KEYS[2])
if m == 1 then redis.call('EXPIRE', KEYS[2], 61) end
return {s, m}
`;

export function createRedisRateLimiter(redis: Redis): PublicRateLimiter {
  return {
    async hit(keyId, { batch, rule }, now = new Date()) {
      const w = windows(now);
      const perMinute = batch ? rule.batchPerMinute : rule.perMinute;
      const kind = batch ? "b" : "m";
      const [s, m] = (await redis.eval(HIT, 2, `papi:rl:s:${keyId}:${w.second}`, `papi:rl:${kind}:${keyId}:${w.minute}`)) as [number, number];
      return decide(s, m, rule.perSecond, perMinute, w.minuteResetSeconds);
    },
  };
}

export function createMemoryRateLimiter(): PublicRateLimiter {
  const counts = new Map<string, { n: number; until: number }>();
  const incr = (k: string, until: number, now: number) => {
    const c = counts.get(k);
    const e = c && c.until > now ? c : { n: 0, until };
    e.n += 1;
    counts.set(k, e);
    if (counts.size > 100_000) for (const [key, v] of counts) if (v.until <= now) counts.delete(key);
    return e.n;
  };
  return {
    async hit(keyId, { batch, rule }, now = new Date()) {
      const w = windows(now);
      const t = now.getTime();
      const s = incr(`s:${keyId}:${w.second}`, (w.second + 1) * 1000, t);
      const m = incr(`${batch ? "b" : "m"}:${keyId}:${w.minute}`, (w.minute + 1) * 60_000, t);
      return decide(s, m, rule.perSecond, batch ? rule.batchPerMinute : rule.perMinute, w.minuteResetSeconds);
    },
  };
}
