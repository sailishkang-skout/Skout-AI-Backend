// cSpell:ignore wiza datagma contactout
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildContactOutBody,
  buildWizaFilters,
  enabledVendors,
  mergePeople,
  searchVendors, fetchWizaDeepList, wizaDeepMax,
  toProspectDocument,
  vendorProspectId,
} from "./vendor-search.service.js";

const env = (over: Record<string, unknown> = {}) =>
  ({
    WIZA_API_KEY: "w-key",
    CONTACTOUT_API_KEY: "c-key",
    DATAGMA_API_KEY: "d-key",
    WIZA_BASE_URL: "https://wiza.test",
    CONTACTOUT_BASE_URL: "https://co.test",
    DATAGMA_BASE_URL: "https://dg.test/api/ingress",
    ...over,
  }) as never;

afterEach(() => vi.unstubAllGlobals());

describe("enabledVendors", () => {
  it("only lists vendors with a live key", () => {
    expect(enabledVendors(env({ CONTACTOUT_API_KEY: "replace-me" }))).toEqual(["wiza"]);
    expect(enabledVendors(env({ WIZA_API_KEY: undefined }))).toEqual(["contactout"]);
  });
});

describe("filter translation", () => {
  it("maps Skout filters to Wiza filters", () => {
    expect(
      buildWizaFilters({ jobTitle: "VP Sales", seniority: "vp", city: "Austin", state: "Texas", country: "United States", companyName: "Acme" })
    ).toEqual({
      job_title: [{ v: "VP Sales", s: "i" }],
      job_title_level: ["VP"],
      location: [{ v: "Austin, Texas, United States", b: "city", s: "i" }],
      job_company: [{ v: "Acme", s: "i" }],
    });
  });

  it("maps Skout filters to a ContactOut body without revealing contact info", () => {
    const b = buildContactOutBody({ jobTitle: "CTO", countries: ["India"], companyDomain: "https://www.acme.com/x" }, 40, 1);
    expect(b).toMatchObject({ job_title: ["CTO"], location: ["India"], domain: ["acme.com"], page_size: 25, reveal_info: false });
  });
});

describe("mergePeople", () => {
  it("de-duplicates across vendors by LinkedIn slug and back-fills gaps", () => {
    const merged = mergePeople([
      { vendor: "wiza", fullName: "Ada Lovelace", linkedinUrl: "https://www.linkedin.com/in/ada/", title: "CTO" },
      { vendor: "contactout", fullName: "Ada Lovelace", linkedinUrl: "https://linkedin.com/in/ada", companyName: "Analytical", title: "Chief Tech" },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ title: "CTO", companyName: "Analytical", vendors: ["wiza", "contactout"] });
  });

  it("gives the same prospectId on re-search", () => {
    const p = { vendor: "wiza" as const, fullName: "Ada", linkedinUrl: "https://linkedin.com/in/ada" };
    expect(vendorProspectId(p)).toBe(vendorProspectId({ ...p, vendor: "contactout" }));
    expect(toProspectDocument(p).dataSource).toBe("vendor");
  });
});

describe("searchVendors", () => {
  const wizaOk = () =>
    new Response(
      JSON.stringify({ data: { total: 120, profiles: [{ full_name: "Ada L", job_title: "CTO", linkedin_url: "https://linkedin.com/in/ada", job_company_name: "Acme" }] } }),
      { status: 200 }
    );
  const coOk = () =>
    new Response(
      JSON.stringify({
        metadata: { total_results: 80 },
        profiles: { "https://linkedin.com/in/bob": { full_name: "Bob B", title: "VP", company: { name: "Acme", domain: "acme.com" } } },
      }),
      { status: 200 }
    );

  it("merges results, reports the largest total, and sends the Wiza bearer token", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => (url.includes("wiza.test") ? wizaOk() : coOk()));
    vi.stubGlobal("fetch", fetchMock);
    const out = await searchVendors(env(), { jobTitle: "CTO" }, 25);
    expect(out.people.map((p) => p.fullName).sort()).toEqual(["Ada L", "Bob B"]);
    expect(out.total).toBe(80); // Wiza's 120 is capped at the 30 it can serve; ContactOut's 80 is the largest reachable
    expect(out.failed).toEqual([]);
    const wizaCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("wiza.test"))!;
    expect(wizaCall[1]).toMatchObject({ headers: { Authorization: "Bearer w-key" } });
  });

  it("asks Wiza for its maximum of 30 whatever the page size, and caps the total at 30", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => wizaOk());
    vi.stubGlobal("fetch", fetchMock);
    const out = await searchVendors({ ...(env() as object), CONTACTOUT_API_KEY: undefined } as never, { jobTitle: "CTO" }, 10);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)).size).toBe(30);
    expect(out.total).toBe(30);
  });

  it("makes scheme-less Wiza LinkedIn URLs absolute", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("wiza.test")
          ? new Response(JSON.stringify({ data: { profiles: [{ full_name: "Z", linkedin_url: "linkedin.com/in/z" }] } }), { status: 200 })
          : new Response(JSON.stringify({ profiles: {} }), { status: 200 })
      )
    );
    const out = await searchVendors(env(), { jobTitle: "CTO" }, 5);
    expect(out.people[0]!.linkedinUrl).toBe("https://linkedin.com/in/z");
  });

  it("tolerates one vendor failing", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.includes("wiza.test") ? new Response("no", { status: 403 }) : coOk())));
    const out = await searchVendors(env(), { jobTitle: "CTO" }, 25);
    expect(out.people).toHaveLength(1);
    expect(out.failed.map((f) => f.vendor)).toEqual(["wiza"]);
  });

  it("rejects ContactOut sample-key responses instead of returning fake people", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("co.test")
          ? new Response(JSON.stringify({ message: "This is a sample response.", profiles: { "https://linkedin.com/in/x": { full_name: "Fake Person" } } }), { status: 200 })
          : wizaOk()
      )
    );
    const out = await searchVendors(env(), { jobTitle: "CTO" }, 25);
    expect(out.people.map((p) => p.fullName)).toEqual(["Ada L"]);
    expect(out.failed[0]).toMatchObject({ vendor: "contactout" });
    expect(out.failed[0]!.error).toMatch(/sample-only/);
  });

  it("asks ContactOut for the requested page and skips Wiza beyond page 1", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => (url.includes("wiza.test") ? wizaOk() : coOk()));
    vi.stubGlobal("fetch", fetchMock);
    await searchVendors(env(), { jobTitle: "CTO" }, 25, 3);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("wiza.test"))).toBe(false);
    const coBody = JSON.parse(String((fetchMock.mock.calls.find((c) => String(c[0]).includes("co.test"))![1] as RequestInit).body));
    expect(coBody.page).toBe(3);
  });
});

describe("wizaDeepMax", () => {
  it("is 0 without a live key or when disabled, otherwise the configured cap", () => {
    expect(wizaDeepMax(env({ WIZA_API_KEY: undefined, WIZA_DEEP_SEARCH_MAX: 100 }))).toBe(0);
    expect(wizaDeepMax(env({ WIZA_DEEP_SEARCH_MAX: 0 }))).toBe(0);
    expect(wizaDeepMax(env({ WIZA_DEEP_SEARCH_MAX: 20 }))).toBe(0); // not above the free 30
    expect(wizaDeepMax(env({ WIZA_DEEP_SEARCH_MAX: 100 }))).toBe(100);
  });

  it("raises the reported Wiza total from 30 up to the cap", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { total: 5000, profiles: [{ full_name: "Ada L" }] } }), { status: 200 })));
    const out = await searchVendors(env({ CONTACTOUT_API_KEY: undefined, WIZA_DEEP_SEARCH_MAX: 100 }), { jobTitle: "CTO" }, 25);
    expect(out.total).toBe(100);
  });
});

describe("fetchWizaDeepList", () => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  it("creates a no-enrichment list, waits for it to finish, and maps the people", async () => {
    const calls: string[] = [];
    let polls = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
      if (url.endsWith("/create_prospect_list")) return json({ data: { id: 77 } });
      if (url.endsWith("/api/lists/77")) return json({ data: { status: ++polls < 2 ? "queued" : "finished" } });
      return json({
        data: [
          { full_name: "Ada L", title: "CTO", linkedin_profile_url: "https://www.linkedin.com/in/ada", company: "Acme", company_domain: "acme.com", company_industry: "Software", location: "London, UK", company_size: 12 },
          { full_name: null },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const people = await fetchWizaDeepList(env(), { jobTitle: "CTO" }, 100, { pollMs: 1 });
    expect(calls).toEqual([
      "POST /api/prospects/create_prospect_list",
      "GET /api/lists/77",
      "GET /api/lists/77",
      "GET /api/lists/77/contacts",
    ]);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.list).toMatchObject({ max_profiles: 100, enrichment_level: "none" });
    expect(people).toEqual([
      expect.objectContaining({ vendor: "wiza", fullName: "Ada L", title: "CTO", companyName: "Acme", companyDomain: "acme.com", industry: "Software", employeeCount: 12 }),
    ]);
  });

  it("does not call Wiza when there are no usable filters", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchWizaDeepList(env(), {}, 100)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives up when the list never finishes", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.endsWith("/create_prospect_list") ? json({ data: { id: 1 } }) : json({ data: { status: "queued" } }))));
    await expect(fetchWizaDeepList(env(), { jobTitle: "CTO" }, 100, { pollMs: 1, timeoutMs: 20 })).rejects.toThrow(/timed out/);
  });
});
