import { afterEach, describe, expect, it, vi } from "vitest";
import { searchProspects, type SearchFilters } from "./index.js";

/** A search server whose index maps `prospectId` the given way; records what it is asked. */
function server(prospectId: object | undefined) {
  const asked: Array<{ url: string; body?: { sort?: unknown } }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    asked.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const answer = String(url).endsWith("/_mapping")
      ? { concrete: { mappings: { properties: prospectId ? { prospectId } : {} } } }
      : { hits: { total: { value: 0 }, hits: [] } };
    return new Response(JSON.stringify(answer), { status: 200 });
  });
  return {
    sorts: () => asked.filter((a) => a.url.endsWith("/_search")).map((a) => a.body!.sort),
    mappingReads: () => asked.filter((a) => a.url.endsWith("/_mapping")).length,
  };
}

// Each test uses its own index name: the id field is remembered per index.
let n = 0;
const config = () => ({ url: "http://search.test", index: `stable-${(n += 1)}` });
const text = { type: "text", fields: { keyword: { type: "keyword" } } };
const stable = (field: string) => [{ updatedAt: "asc" }, { [field]: "asc" }];

afterEach(() => vi.restoreAllMocks());

describe.each([
  ["plain", {}],
  ["post-processed", { maxPerCompany: 1 }],
] as Array<[string, SearchFilters]>)("stable order (%s search)", (_name, extra) => {
  const filters = { ...extra, stableOrder: true };

  it("sorts on prospectId where it is a keyword", async () => {
    const os = server({ type: "keyword" });
    await searchProspects(config(), filters);
    expect(os.sorts()).toEqual([stable("prospectId")]);
  });

  it("sorts on prospectId.keyword where the index mapped it as text", async () => {
    const os = server(text);
    await searchProspects(config(), filters);
    expect(os.sorts()).toEqual([stable("prospectId.keyword")]);
  });

  it("reads the mapping once per index", async () => {
    const os = server(text);
    const cfg = config();
    await searchProspects(cfg, filters);
    await searchProspects(cfg, filters, 2);
    expect(os.mappingReads()).toBe(1);
  });

  it("looks again while the index has no prospect id mapped yet", async () => {
    const os = server(undefined);
    const cfg = config();
    await searchProspects(cfg, filters);
    await searchProspects(cfg, filters);
    expect(os.mappingReads()).toBe(2);
  });

  it("reads no mapping for a search that does not need a stable order", async () => {
    const os = server(text);
    await searchProspects(config(), extra);
    expect(os.mappingReads()).toBe(0);
    expect(os.sorts()).toEqual([[{ updatedAt: "desc" }]]);
  });
});
