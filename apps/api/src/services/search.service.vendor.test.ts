// cSpell:ignore wiza opensearch contactout
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const osSearch = vi.fn();
const bulkCreate = vi.fn();
vi.mock("@skout/opensearch", async (orig) => ({
  ...(await orig<typeof import("@skout/opensearch")>()),
  searchProspects: (...a: unknown[]) => osSearch(...a),
  bulkCreateProspects: (...a: unknown[]) => bulkCreate(...a),
}));

import { SearchService } from "./search.service.js";

const env = {
  OPENSEARCH_URL: "https://os.test",
  WIZA_API_KEY: "w",
  WIZA_BASE_URL: "https://wiza.test",
  DEMO_CORPUS_SIZE: 10,
} as never;

const doc = (n: number) => ({ prospectId: `p${n}`, companyId: "c", fullName: `Person ${n}`, companyDomain: "acme.com", updatedAt: "2026-01-01T00:00:00Z" });
const wizaResponse = () =>
  new Response(JSON.stringify({ data: { total: 90, profiles: [{ full_name: "Ada L", linkedin_url: "https://linkedin.com/in/ada" }] } }), { status: 200 });

beforeEach(() => {
  osSearch.mockReset();
  bulkCreate.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("SearchService vendor-backed search", () => {
  it("serves a full page from our own index without calling any vendor", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    osSearch.mockResolvedValue({ hits: [doc(1), doc(2)], total: 60 });
    const res = await new SearchService(env, {} as never).searchProspects({ page: 2, pageSize: 2, filters: { jobTitle: "CTO" } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(osSearch.mock.calls[0]![1]).toMatchObject({ dataSource: ["vendor", "linkedin_capture"], stableOrder: true });
    expect(res).toMatchObject({ total: 60, source: "opensearch" });
  });

  it("tags people that came from a LinkedIn capture as extension-sourced", async () => {
    vi.stubGlobal("fetch", vi.fn());
    osSearch.mockResolvedValue({
      hits: [{ ...doc(1), dataSource: "linkedin_capture" }, { ...doc(2), dataSource: "vendor" }],
      total: 2,
    });
    const res = await new SearchService(env, {} as never).searchProspects({ page: 1, pageSize: 2, filters: { jobTitle: "CTO" } });
    expect(res.results.map((r) => (r as { origin?: string }).origin)).toEqual(["extension", undefined]);
  });

  it("tops up from vendors when the index is thin, saves create-only, and re-reads the index", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => wizaResponse()));
    osSearch.mockResolvedValueOnce({ hits: [], total: 0 }).mockResolvedValueOnce({ hits: [doc(9)], total: 1 });
    bulkCreate.mockResolvedValue({ created: 1, existing: 0, failed: 0 });
    const res = await new SearchService(env, {} as never).searchProspects({ page: 1, pageSize: 25, filters: { jobTitle: "CTO" } });
    expect(bulkCreate).toHaveBeenCalledTimes(1);
    expect(bulkCreate.mock.calls[0]![1][0]).toMatchObject({ fullName: "Ada L", dataSource: "vendor" });
    expect(res.results[0]!.prospectId).toBe("p9");
    expect(res).toMatchObject({ source: "vendor", total: 30 }); // vendor-reported total (Wiza 90, capped to the 30 it can serve), not just what is stored
  });

  it("returns 502 when every vendor fails and nothing is stored", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("forbidden", { status: 403 })));
    osSearch.mockResolvedValue({ hits: [], total: 0 });
    await expect(
      new SearchService(env, {} as never).searchProspects({ page: 1, pageSize: 25, filters: { jobTitle: "CTO" } })
    ).rejects.toMatchObject({ statusCode: 502 });
  });

  it("pulls a deeper list once, on the first page past what is stored, then serves later pages from the index", async () => {
    const deepEnv = { ...(env as object), WIZA_DEEP_SEARCH_MAX: 100 } as never;
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      if (url.endsWith("/create_prospect_list")) return new Response(JSON.stringify({ data: { id: 9 } }), { status: 200 });
      if (url.endsWith("/api/lists/9")) return new Response(JSON.stringify({ data: { status: "finished" } }), { status: 200 });
      return new Response(JSON.stringify({ data: [{ full_name: "Deep Person", linkedin_profile_url: "https://linkedin.com/in/deep" }] }), { status: 200 });
    }));
    osSearch.mockResolvedValueOnce({ hits: [], total: 30 }).mockResolvedValueOnce({ hits: [doc(31)], total: 31 });
    bulkCreate.mockResolvedValue({ created: 1, existing: 0, failed: 0 });
    const svc = new SearchService(deepEnv, {} as never);
    const filters = { jobTitle: "Deep-once-only" };
    const res = await svc.searchProspects({ page: 2, pageSize: 25, filters });
    expect(urls.some((u) => u.endsWith("/create_prospect_list"))).toBe(true);
    expect(res.results[0]!.prospectId).toBe("p31");

    // Same search, next page: the claim is already taken, so no second paid list is created.
    urls.length = 0;
    osSearch.mockResolvedValue({ hits: [], total: 31 });
    await svc.searchProspects({ page: 3, pageSize: 25, filters });
    expect(urls.some((u) => u.endsWith("/create_prospect_list"))).toBe(false);
  });

  it("never exposes provider names in the error when all vendors fail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("forbidden", { status: 403 })));
    osSearch.mockResolvedValue({ hits: [], total: 0 });
    await expect(
      new SearchService(env, {} as never).searchProspects({ page: 1, pageSize: 25, filters: { jobTitle: "CTO" } })
    ).rejects.toMatchObject({ statusCode: 502, message: expect.not.stringMatching(/wiza|contactout/i) });
  });
});

