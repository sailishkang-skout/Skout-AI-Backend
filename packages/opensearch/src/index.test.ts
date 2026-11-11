import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSearchQuery, getProspectById } from "./index.js";

describe("buildSearchQuery", () => {
  it("returns match_all when no filters", () => {
    const q = buildSearchQuery({}, 1, 10);
    expect(q.size).toBe(10);
    expect(q.from).toBe(0);
    expect(q.query.bool.must).toEqual([{ match_all: {} }]);
  });

  it("adds term filters and multi_match for query text", () => {
    const q = buildSearchQuery(
      { query: "acme", industry: "Software", country: "US", minEmployees: 50 },
      2,
      25
    );
    expect(q.from).toBe(25);
    expect(q.query.bool.must).toHaveLength(1);
    expect(q.query.bool.filter).toEqual(
      expect.arrayContaining([
        { term: { industry: "Software" } },
        { term: { country: "US" } },
        { range: { employeeCount: { gte: 50 } } },
      ])
    );
  });
});

describe("OpenSearch 429 handling", () => {
  afterEach(() => vi.restoreAllMocks());

  const cfg = { url: "https://os.example", index: "prospects" };
  const tooMany = () =>
    new Response(JSON.stringify({ code: 429, message: "Concurrent request limit" }), { status: 429 });

  it("retries a 429 and returns the document once the cluster accepts the request", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => tooMany())
      .mockImplementationOnce(async () => tooMany())
      .mockImplementation(async () => new Response(JSON.stringify({ _source: { prospectId: "p1" } }), { status: 200 }));
    const doc = await getProspectById(cfg, "p1");
    expect(doc).toEqual({ prospectId: "p1" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives up after repeated 429s", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => tooMany());
    expect(await getProspectById(cfg, "p1")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
