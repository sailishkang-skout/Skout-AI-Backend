import { afterEach, describe, expect, it, vi } from "vitest";
import { CoresignalFirmographics } from "./coresignal.js";
import { ExploriumFirmographics } from "./explorium.js";
import { PeopleDataLabsFirmographics } from "./peopledatalabs.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("firmographic lookups for LinkedIn capture domains", () => {
  it("uses the company name instead of a placeholder website with People Data Labs", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      new Response(JSON.stringify({ status: 200, name: "EY", industry: "Consulting" }), {
        status: 200,
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new PeopleDataLabsFirmographics("test-key");
    const company = await provider.fetchCompany("ey-technology-solutions.linkedin", "EY Technology Solutions");

    const requestedUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(requestedUrl.searchParams.has("website")).toBe(false);
    expect(requestedUrl.searchParams.get("name")).toBe("EY Technology Solutions");
    expect(company?.companyName).toBe("EY");
  });

  it("matches by company name instead of a placeholder website with Explorium", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ matched_businesses: [{ business_id: "business-1" }] }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { name: "EY", linkedin_industry_category: "Consulting" } }), {
          status: 200,
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new ExploriumFirmographics("test-key");
    const company = await provider.fetchCompany("ey-technology-solutions.linkedin", "EY Technology Solutions");

    const matchRequest = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(matchRequest.businesses_to_match).toEqual([{ name: "EY Technology Solutions" }]);
    expect(company?.companyName).toBe("EY");
  });

  it("does not query Coresignal with a placeholder website", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const provider = new CoresignalFirmographics("test-key");
    await expect(
      provider.fetchCompany("ey-technology-solutions.linkedin", "EY Technology Solutions")
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
