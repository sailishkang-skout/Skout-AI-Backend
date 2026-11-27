import type { Redis } from "ioredis";

/**
 * Per-key daily count quotas (PAPI-033, public API PRD RL-5, RL-6): email verifications (default
 * 5,000) and search results (default 10,000) per key per UTC day. Counted in Redis (shared by every
 * instance, RL-1), keyed by key id and UTC date, so each count resets at UTC midnight.
 *
 * `tryConsume` takes units only if they fit (atomically); `refund` gives back what wasn't used, e.g.
 * a search page that returned fewer results than were reserved.
 */
export type QuotaKind = "verify" | "search_results";

export interface QuotaResult {
  ok: boolean;
  used: number;
  limit: number;
  resetsAt: Date;
}

export interface QuotaStore {
  tryConsume(kind: QuotaKind, keyId: string, units: number, limit: number, now?: Date): Promise<QuotaResult>;
  refund(kind: QuotaKind, keyId: string, units: number, now?: Date): Promise<void>;
  used(kind: QuotaKind, keyId: string, now?: Date): Promise<number>;
}

function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}
function nextMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}
const keyFor = (kind: QuotaKind, keyId: string, now: Date) => `papi:quota:${kind}:${keyId}:${utcDate(now)}`;

// KEYS[1] = counter, ARGV = units, limit, expire-at (unix s). Returns [ok(1/0), used].
const TRY_CONSUME = `
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local units = tonumber(ARGV[1])
if used + units > tonumber(ARGV[2]) then return {0, used} end
used = redis.call('INCRBY', KEYS[1], units)
redis.call('EXPIREAT', KEYS[1], ARGV[3])
return {1, used}
`;

export function createRedisQuotaStore(redis: Redis): QuotaStore {
  return {
    async tryConsume(kind, keyId, units, limit, now = new Date()) {
      const resetsAt = nextMidnight(now);
      // Keep the counter a day past the reset so a late refund still lands on the right day.
      const expireAt = Math.floor(resetsAt.getTime() / 1000) + 86_400;
      const [ok, used] = (await redis.eval(TRY_CONSUME, 1, keyFor(kind, keyId, now), units, limit, expireAt)) as [number, number];
      return { ok: ok === 1, used, limit, resetsAt };
    },
    async refund(kind, keyId, units, now = new Date()) {
      if (units <= 0) return;
      const k = keyFor(kind, keyId, now);
      const left = await redis.decrby(k, units);
      if (left < 0) await redis.set(k, "0", "KEEPTTL");
    },
    async used(kind, keyId, now = new Date()) {
      return Number((await redis.get(keyFor(kind, keyId, now))) ?? 0);
    },
  };
}

/** Per-process fallback when Redis isn't available (local dev, CI). */
export function createMemoryQuotaStore(): QuotaStore {
  const counts = new Map<string, number>();
  return {
    async tryConsume(kind, keyId, units, limit, now = new Date()) {
      const k = keyFor(kind, keyId, now);
      const used = counts.get(k) ?? 0;
      if (used + units > limit) return { ok: false, used, limit, resetsAt: nextMidnight(now) };
      counts.set(k, used + units);
      return { ok: true, used: used + units, limit, resetsAt: nextMidnight(now) };
    },
    async refund(kind, keyId, units, now = new Date()) {
      const k = keyFor(kind, keyId, now);
      counts.set(k, Math.max(0, (counts.get(k) ?? 0) - Math.max(0, units)));
    },
    async used(kind, keyId, now = new Date()) {
      return counts.get(keyFor(kind, keyId, now)) ?? 0;
    },
  };
}
