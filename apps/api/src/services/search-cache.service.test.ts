import { describe, expect, it } from "vitest";
import type { SearchProspectsResponse } from "@skout/shared";
import { buildSearchCacheKey, clearSearchMemoryCache, createSearchCacheService } from "./search-cache.service.js";
import type { Env } from "../config/env.js";

const env = {
  REDIS_URL: "redis://127.0.0.1:1",
  SEARCH_CACHE_TTL_SECONDS: 60,
  PROSPECT_CACHE_TTL_SECONDS: 30,
  SMART_LIST_CACHE_TTL_SECONDS: 60,
} as Env;

describe("SearchCacheService", () => {
  it("builds stable cache keys for identical requests", () => {
    const body = { query: "vp sales", page: 1, pageSize: 25, filters: { country: "US" } };
    const a = buildSearchCacheKey("ws-1", body);
    const b = buildSearchCacheKey("ws-1", { ...body });
    const c = buildSearchCacheKey("ws-2", body);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("stores and reads from in-memory fallback when Redis is unavailable", async () => {
    clearSearchMemoryCache();
    const cache = createSearchCacheService(env);
    const payload: Omit<SearchProspectsResponse, "cached" | "creditsUsed"> = {
      results: [],
      total: 0,
      page: 1,
      pageSize: 25,
    };

    await cache.set("search:test:key", payload);
    await expect(cache.get("search:test:key")).resolves.toEqual(payload);
  });
});
