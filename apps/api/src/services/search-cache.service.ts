import { createHash } from "node:crypto";
import type { SearchProspectsRequest, SearchProspectsResponse } from "@skout/shared";
import type { Env } from "../config/env.js";
import { getRedis } from "../lib/redis.js";

type CachedSearchPayload = Omit<SearchProspectsResponse, "cached" | "creditsUsed">;

interface MemoryEntry {
  expiresAt: number;
  payload: CachedSearchPayload;
}

const memoryCache = new Map<string, MemoryEntry>();

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(obj[key])}`).join(",")}}`;
}

export function buildSearchCacheKey(workspaceId: string, body: SearchProspectsRequest): string {
  const hash = createHash("sha256")
    .update(
      stableSerialize({
        query: body.query ?? "",
        filters: body.filters ?? {},
        page: body.page ?? 1,
        pageSize: body.pageSize ?? 25,
      })
    )
    .digest("hex");
  return `search:${workspaceId}:${hash}`;
}

export class SearchCacheService {
  constructor(private readonly env: Env) {}

  private ttlSeconds(): number {
    return this.env.SEARCH_CACHE_TTL_SECONDS;
  }

  async get(key: string): Promise<CachedSearchPayload | null> {
    const redis = getRedis(this.env);
    if (redis) {
      try {
        if (redis.status === "wait") await redis.connect();
        const raw = await redis.get(key);
        if (!raw) return null;
        return JSON.parse(raw) as CachedSearchPayload;
      } catch {
        // fall through to in-process cache
      }
    }

    const entry = memoryCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      memoryCache.delete(key);
      return null;
    }
    return entry.payload;
  }

  async set(key: string, payload: CachedSearchPayload): Promise<void> {
    const ttl = this.ttlSeconds();
    const redis = getRedis(this.env);
    if (redis) {
      try {
        if (redis.status === "wait") await redis.connect();
        await redis.set(key, JSON.stringify(payload), "EX", ttl);
        return;
      } catch {
        // fall through to in-process cache
      }
    }

    memoryCache.set(key, {
      payload,
      expiresAt: Date.now() + ttl * 1000,
    });
  }
}

export function createSearchCacheService(env: Env): SearchCacheService {
  return new SearchCacheService(env);
}

/** Test helper — clears in-process fallback entries. */
export function clearSearchMemoryCache(): void {
  memoryCache.clear();
}
