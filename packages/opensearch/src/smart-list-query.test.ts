import { afterEach, describe, expect, it, vi } from "vitest";
import {
  countProspects,
  fetchProspectFacets,
  prospectIdsStillMatching,
  runSmartListQueryWithFallback,
  seniorityClause,
} from "./index.js";

const cfg = { url: "http://os.test", index: "prospects" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("smart-list queries", () => {
  afterEach(() => vi.restoreAllMocks());

  it("countProspects returns the exact total for the filters via _count", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ count: 1234 }));
    const total = await countProspects(cfg, { seniority: "vp" });
    expect(total).toBe(1234);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://os.test/prospects/_count");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.query.bool.filter).toContainEqual(seniorityClause(["vp"]));
    expect(body).not.toHaveProperty("sort");
  });

  it("fetchProspectFacets returns stored values with counts per field", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({
        hits: { total: { value: 6806 } },
        aggregations: {
          industry: { buckets: [{ key: "FinTech", doc_count: 533 }] },
          country: { buckets: [{ key: "IN", doc_count: 532 }, { key: "India", doc_count: 369 }] },
          seniority: { buckets: [{ key: "vp", doc_count: 764 }] },
        },
      })
    );
    const facets = await fetchProspectFacets(cfg);
    expect(facets.total).toBe(6806);
    expect(facets.industry).toEqual([{ value: "FinTech", count: 533 }]);
    expect(facets.country).toEqual([
      { value: "IN", count: 532 },
      { value: "India", count: 369 },
    ]);
    expect(facets.seniority).toEqual([{ value: "vp", count: 764 }]);
  });

  it("runSmartListQueryWithFallback returns the true total, not just the hits it kept", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({ hits: { total: { value: 4200, relation: "eq" }, hits: [{ _source: { prospectId: "p1" } }] } })
    );
    const out = await runSmartListQueryWithFallback(cfg, {}, 1);
    expect(out).toMatchObject({ total: 4200, demo: false });
    expect(out.hits).toHaveLength(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(body.track_total_hits).toBe(true);
  });

  it("does NOT fall back to demo data when OpenSearch is configured but fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "boom" }, 500));
    await expect(runSmartListQueryWithFallback(cfg, {})).rejects.toThrow(/OpenSearch 500/);
  });

  it("uses demo data only when OpenSearch isn't configured at all", async () => {
    const out = await runSmartListQueryWithFallback(null, {}, 5);
    expect(out.demo).toBe(true);
    expect(out.hits.length).toBeGreaterThan(0);
  });

  it("prospectIdsStillMatching returns which of the given prospects still match the filters", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({ hits: { total: { value: 1 }, hits: [{ _source: { prospectId: "p2" } }] } })
    );
    const still = await prospectIdsStillMatching(cfg, { seniority: "vp" }, ["p1", "p2"]);
    expect([...still]).toEqual(["p2"]);
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(body.query.bool.filter).toContainEqual({
      bool: {
        should: [{ terms: { prospectId: ["p1", "p2"] } }, { terms: { "prospectId.keyword": ["p1", "p2"] } }],
        minimum_should_match: 1,
      },
    });
    expect(body.size).toBe(2);
  });

  it("prospectIdsStillMatching makes no request for an empty list", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    expect((await prospectIdsStillMatching(cfg, {}, [])).size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
