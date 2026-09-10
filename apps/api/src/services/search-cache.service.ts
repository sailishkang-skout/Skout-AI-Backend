import { createHash } from "node:crypto";
import type { SearchProspectsRequest, SearchProspectsResponse } from "@skout/shared";
import type { Env } from "../config/env.js";
import { getRedis } from "../lib/redis.js";

type CachedSearchPayload = Omit<SearchProspectsResponse, "cached" | "creditsUsed">;

interface MemoryEntry {
  expiresAt: number;
  payload: unknown;
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

export function buildProspectCacheKey(workspaceId: string, prospectId: string): string {
  return `prospect:${workspaceId}:${prospectId}`;
}

export function buildSmartListCacheKey(workspaceId: string, smartListId: string): string {
  return `smart-list:${workspaceId}:${smartListId}`;
}

export class SearchCacheService {
  constructor(private readonly env: Env) {}

  private async getRaw(key: string): Promise<unknown> {
    const redis = getRedis(this.env);
    if (redis) {
      try {
        if (redis.status === "wait") await redis.connect();
        const raw = await redis.get(key);
        if (!raw) return null;
        return JSON.parse(raw) as unknown;
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

  private async setRaw(key: string, payload: unknown, ttl: number): Promise<void> {
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
    memoryCache.set(key, { payload, expiresAt: Date.now() + ttl * 1000 });
  }

  private async invalidateRaw(key: string): Promise<void> {
    memoryCache.delete(key);
    const redis = getRedis(this.env);
    if (redis) {
      try {
        if (redis.status === "wait") await redis.connect();
        await redis.del(key);
      } catch {
        // best-effort
      }
    }
  }

  // --- Search result pages ---

  async get(key: string): Promise<CachedSearchPayload | null> {
    return (await this.getRaw(key)) as CachedSearchPayload | null;
  }

  async set(key: string, payload: CachedSearchPayload): Promise<void> {
    return this.setRaw(key, payload, this.env.SEARCH_CACHE_TTL_SECONDS);
  }

  // --- Prospect-by-ID (drawer) ---

  async getById(workspaceId: string, prospectId: string): Promise<Record<string, unknown> | null> {
    const key = buildProspectCacheKey(workspaceId, prospectId);
    return (await this.getRaw(key)) as Record<string, unknown> | null;
  }

  async setById(workspaceId: string, prospectId: string, doc: Record<string, unknown>): Promise<void> {
    const key = buildProspectCacheKey(workspaceId, prospectId);
    return this.setRaw(key, doc, this.env.PROSPECT_CACHE_TTL_SECONDS);
  }

  async invalidateById(workspaceId: string, prospectId: string): Promise<void> {
    return this.invalidateRaw(buildProspectCacheKey(workspaceId, prospectId));
  }

  // --- Smart-list run results ---

  async getSmartList(workspaceId: string, smartListId: string): Promise<Record<string, unknown> | null> {
    const key = buildSmartListCacheKey(workspaceId, smartListId);
    return (await this.getRaw(key)) as Record<string, unknown> | null;
  }

  async setSmartList(workspaceId: string, smartListId: string, payload: Record<string, unknown>): Promise<void> {
    const key = buildSmartListCacheKey(workspaceId, smartListId);
    return this.setRaw(key, payload, this.env.SMART_LIST_CACHE_TTL_SECONDS);
  }

  async invalidateSmartList(workspaceId: string, smartListId: string): Promise<void> {
    return this.invalidateRaw(buildSmartListCacheKey(workspaceId, smartListId));
  }
}

export function createSearchCacheService(env: Env): SearchCacheService {
  return new SearchCacheService(env);
}

/** Test helper — clears in-process fallback entries. */
export function clearSearchMemoryCache(): void {
  memoryCache.clear();
}
