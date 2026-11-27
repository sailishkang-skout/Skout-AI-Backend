import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { bulkUpsertProspects, ensureProspectsIndex, type ProspectDocument } from "@skout/opensearch";
import { SearchService } from "./search.service.js";

/**
 * Vendor-backed search against a real search server, with both ways its prospect ids can be mapped.
 *
 * Skipped unless pointed at a search server that is safe to fill and empty:
 *   SEARCH_TEST_OPENSEARCH_URL=http://localhost:59200 npx vitest run src/services/search.service.search-server.test.ts
 */
const searchUrl = process.env.SEARCH_TEST_OPENSEARCH_URL;
const PEOPLE = 60;

describe.skipIf(!searchUrl).each(["created by Skout", "mapped dynamically"] as const)("vendor-backed search on an index %s", (mapping) => {
  const letters = Array.from({ length: 8 }, () => "abcdefghij"[Math.floor(Math.random() * 10)]).join("");
  const index = `stable-order-${letters}`;
  const cfg = { url: searchUrl!, index };
  const env = { OPENSEARCH_URL: searchUrl, OPENSEARCH_INDEX: index, WIZA_API_KEY: "w", WIZA_BASE_URL: "https://wiza.test", DEMO_CORPUS_SIZE: 10 } as never;

  // Every person has the same timestamp, so only the id orders them: pages repeat people unless that works.
  const person = (i: number): ProspectDocument => ({
    prospectId: `${letters}${String(i).padStart(4, "0")}`,
    companyId: "c",
    fullName: `Stored Person ${i}`,
    title: "Analyst",
    companyDomain: `company${i}.com`,
    companyName: "Stored",
    dataSource: "vendor",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const refresh = () => fetch(`${searchUrl}/${index}/_refresh`, { method: "POST" });

  /** Lets requests through to the search server and records any made to anyone else. */
  function watchVendors() {
    const calls: string[] = [];
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (String(url).startsWith(searchUrl!)) return real(url, init);
      calls.push(String(url));
      return new Response("unavailable", { status: 503 });
    });
    return calls;
  }

  beforeAll(async () => {
    if (mapping === "created by Skout") await ensureProspectsIndex(cfg);
    const docs = Array.from({ length: PEOPLE }, (_, i) => person(i));
    expect((await bulkUpsertProspects(cfg, docs)).failed).toBe(0);
    await refresh();
    const mapped = (await (await fetch(`${searchUrl}/${index}/_mapping`)).json()) as Record<string, { mappings: { properties: { prospectId: { type: string } } } }>;
    expect(mapped[index]!.mappings.properties.prospectId.type).toBe(mapping === "created by Skout" ? "keyword" : "text");
  }, 60_000);

  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    await fetch(`${searchUrl}/${index}`, { method: "DELETE" });
  });

  it.each([
    ["plain", {}],
    ["one per company", { maxPerCompany: 1 }],
  ])("serves stored people page by page without calling a vendor (%s)", async (_name, extra) => {
    const vendorCalls = watchVendors();
    const service = new SearchService(env, {} as never);
    const seen: string[] = [];
    for (const page of [1, 2, 3]) {
      const res = await service.searchProspects({ page, pageSize: 20, filters: { jobTitle: "Analyst", ...extra } });
      expect(res).toMatchObject({ source: "opensearch", total: PEOPLE });
      seen.push(...res.results.map((r) => r.prospectId));
    }
    expect(vendorCalls).toEqual([]);
    expect(seen).toEqual(Array.from({ length: PEOPLE }, (_, i) => person(i).prospectId));
  });

  it("still serves stored people on a short page when every vendor is down", async () => {
    const vendorCalls = watchVendors();
    const res = await new SearchService(env, {} as never).searchProspects({ page: 1, pageSize: 100, filters: { jobTitle: "Analyst" } });
    expect(vendorCalls.length).toBeGreaterThan(0);
    expect(res.results).toHaveLength(PEOPLE);
  });
});
