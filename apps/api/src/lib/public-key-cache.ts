import { EventEmitter } from "node:events";
import { Redis } from "ioredis";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { createLogger } from "@skout/observability";

const log = createLogger("public-key-cache");
const { apiKeys, workspaceApiSettings } = schema;

/**
 * PAPI-023 (KEY-9): resolved public API keys are cached for at most 60 seconds, in each instance's
 * memory and in Redis. Revoke, rotate, expiry and add-on changes publish an invalidation that every
 * instance listens to, so a revoked key stops working everywhere within seconds, not after the TTL.
 */
export const KEY_CACHE_TTL_MS = 60_000;
export const KEY_INVALIDATION_CHANNEL = "papi:key-invalidate";
const REDIS_PREFIX = "papi:key:";

export type ApiKeyRow = typeof apiKeys.$inferSelect;

export interface CachedKey {
  key: ApiKeyRow;
  /** The workspace's API add-on switch at lookup time (ADD-5). */
  addonEnabled: boolean;
}

/** Which cached keys to drop: specific prefixes, every key of a workspace, or both. */
export interface KeyInvalidation {
  prefixes?: string[];
  workspaceId?: string;
}

export interface KeyInvalidationBus {
  publish(msg: KeyInvalidation): Promise<void>;
  subscribe(handler: (msg: KeyInvalidation) => void): Promise<() => Promise<void>>;
}

/** Same-process bus: for a single instance without Redis, and for tests. */
export function createMemoryInvalidationBus(): KeyInvalidationBus {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  return {
    async publish(msg) {
      emitter.emit("msg", msg);
    },
    async subscribe(handler) {
      emitter.on("msg", handler);
      return async () => {
        emitter.off("msg", handler);
      };
    },
  };
}

/** Redis pub/sub bus shared by every API instance. Uses its own connections (a subscriber can't run commands). */
export function createRedisInvalidationBus(redisUrl: string): KeyInvalidationBus {
  const tls = new URL(redisUrl).protocol === "rediss:" ? { tls: {} } : {};
  const pub = new Redis(redisUrl, { maxRetriesPerRequest: 2, ...tls });
  pub.on("error", (err) => log.warn("key invalidation publisher error", { err: err.message }));
  return {
    async publish(msg) {
      await pub.publish(KEY_INVALIDATION_CHANNEL, JSON.stringify(msg));
    },
    async subscribe(handler) {
      const sub = new Redis(redisUrl, { maxRetriesPerRequest: null, ...tls });
      sub.on("error", (err) => log.warn("key invalidation subscriber error", { err: err.message }));
      sub.on("message", (channel, raw) => {
        if (channel !== KEY_INVALIDATION_CHANNEL) return;
        try {
          handler(JSON.parse(raw) as KeyInvalidation);
        } catch (err) {
          log.warn("bad key invalidation message", { err: (err as Error).message });
        }
      });
      await sub.subscribe(KEY_INVALIDATION_CHANNEL);
      return async () => {
        await sub.quit().catch(() => undefined);
        await pub.quit().catch(() => undefined);
      };
    },
  };
}

const DATE_FIELDS = ["expiresAt", "lastUsedAt", "revokedAt", "graceUntil", "createdAt"] as const;

function reviveRow(raw: Record<string, unknown>): ApiKeyRow {
  const row = { ...raw } as Record<string, unknown>;
  for (const f of DATE_FIELDS) row[f] = row[f] == null ? null : new Date(row[f] as string);
  return row as unknown as ApiKeyRow;
}

export interface PublicKeyCacheOptions {
  bus: KeyInvalidationBus;
  /** Shared Redis cache; null keeps only the per-instance memory cache. */
  redis?: Redis | null;
  ttlMs?: number;
  clock?: () => number;
}

export class PublicKeyCache {
  private readonly local = new Map<string, { value: CachedKey; until: number }>();
  private readonly ttlMs: number;
  private readonly clock: () => number;
  private unsubscribe: (() => Promise<void>) | null = null;

  constructor(
    private readonly db: Db,
    private readonly opts: PublicKeyCacheOptions
  ) {
    this.ttlMs = Math.min(opts.ttlMs ?? KEY_CACHE_TTL_MS, KEY_CACHE_TTL_MS);
    this.clock = opts.clock ?? Date.now;
  }

  /** Starts listening for invalidations from every instance. */
  async start(): Promise<void> {
    if (this.unsubscribe) return;
    this.unsubscribe = await this.opts.bus.subscribe((msg) => this.dropLocal(msg));
  }

  async stop(): Promise<void> {
    await this.unsubscribe?.();
    this.unsubscribe = null;
    this.local.clear();
  }

  /** The key row for a prefix (and its workspace's add-on switch), from memory, Redis or the database. */
  async get(prefix: string): Promise<CachedKey | null> {
    const now = this.clock();
    const hit = this.local.get(prefix);
    if (hit && hit.until > now) return hit.value;
    if (hit) this.local.delete(prefix);

    const fromRedis = await this.readRedis(prefix);
    if (fromRedis) {
      this.local.set(prefix, { value: fromRedis, until: now + this.ttlMs });
      return fromRedis;
    }

    const [row] = await this.db
      .select({ key: apiKeys, addonEnabled: workspaceApiSettings.addonEnabled })
      .from(apiKeys)
      .leftJoin(workspaceApiSettings, eq(workspaceApiSettings.workspaceId, apiKeys.workspaceId))
      .where(eq(apiKeys.prefix, prefix))
      .limit(1);
    if (!row) return null; // unknown prefixes are not cached
    const value: CachedKey = { key: row.key, addonEnabled: Boolean(row.addonEnabled) };
    this.local.set(prefix, { value, until: now + this.ttlMs });
    await this.writeRedis(prefix, value);
    return value;
  }

  /** Drops the keys everywhere: this instance, Redis, and (via the bus) every other instance. */
  async invalidate(msg: KeyInvalidation): Promise<void> {
    const prefixes = new Set(msg.prefixes ?? []);
    if (msg.workspaceId) {
      const rows = await this.db.select({ prefix: apiKeys.prefix }).from(apiKeys).where(eq(apiKeys.workspaceId, msg.workspaceId));
      for (const r of rows) prefixes.add(r.prefix);
    }
    const full: KeyInvalidation = { prefixes: [...prefixes], ...(msg.workspaceId ? { workspaceId: msg.workspaceId } : {}) };
    this.dropLocal(full);
    if (this.opts.redis && full.prefixes!.length > 0) {
      await this.opts.redis.del(...full.prefixes!.map((p) => REDIS_PREFIX + p)).catch((err: Error) => {
        log.warn("could not delete cached keys from Redis", { err: err.message });
      });
    }
    await this.opts.bus.publish(full);
  }

  private dropLocal(msg: KeyInvalidation) {
    for (const p of msg.prefixes ?? []) this.local.delete(p);
    if (msg.workspaceId) {
      for (const [p, entry] of this.local) if (entry.value.key.workspaceId === msg.workspaceId) this.local.delete(p);
    }
  }

  private async readRedis(prefix: string): Promise<CachedKey | null> {
    if (!this.opts.redis) return null;
    try {
      const raw = await this.opts.redis.get(REDIS_PREFIX + prefix);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { key: Record<string, unknown>; addonEnabled: boolean };
      return { key: reviveRow(parsed.key), addonEnabled: parsed.addonEnabled };
    } catch {
      return null;
    }
  }

  private async writeRedis(prefix: string, value: CachedKey): Promise<void> {
    if (!this.opts.redis) return;
    await this.opts.redis.set(REDIS_PREFIX + prefix, JSON.stringify(value), "PX", this.ttlMs).catch(() => undefined);
  }
}

// --- Process-wide notifier ---------------------------------------------------

type Invalidator = (msg: KeyInvalidation) => Promise<void>;
let invalidator: Invalidator | null = null;

/** Set by the app at start-up so services can announce key changes without holding the cache. */
export function setPublicKeyInvalidator(fn: Invalidator | null): void {
  invalidator = fn;
}

/** Clears the invalidator only if it is still `fn` (another app in the same process may have replaced it). */
export function clearPublicKeyInvalidator(fn: Invalidator): void {
  if (invalidator === fn) invalidator = null;
}

/** Announces a key change after it is committed. Never throws: the database is already right. */
export async function notifyPublicKeyChange(msg: KeyInvalidation): Promise<void> {
  if (!invalidator) return;
  try {
    await invalidator(msg);
  } catch (err) {
    log.warn("key invalidation failed; caches expire within 60 seconds anyway", { err: (err as Error).message });
  }
}
