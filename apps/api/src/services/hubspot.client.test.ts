import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isHubSpotRetryableError,
  searchHubSpotContactsModifiedSince,
  searchHubSpotDealsModifiedSince,
  updateHubSpotContact,
  updateHubSpotDeal,
} from "./hubspot.client.js";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("searchHubSpotContactsModifiedSince", () => {
  it("posts a GTE filter on hs_lastmodifieddate, sorted ascending", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [{ id: "c-1", properties: {} }] }));
    vi.stubGlobal("fetch", fetchMock);

    const results = await searchHubSpotContactsModifiedSince("token", "2026-01-01T00:00:00.000Z", 10);

    expect(results).toEqual([{ id: "c-1", properties: {} }]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/crm/v3/objects/contacts/search");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.filterGroups[0].filters[0]).toEqual({
      propertyName: "hs_lastmodifieddate",
      operator: "GTE",
      value: "2026-01-01T00:00:00.000Z",
    });
    expect(body.sorts[0]).toEqual({ propertyName: "hs_lastmodifieddate", direction: "ASCENDING" });
  });

  it("paginates via the after cursor until maxContacts is reached", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ results: [{ id: "c-1" }], paging: { next: { after: "cursor-1" } } })
      )
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: "c-2" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const results = await searchHubSpotContactsModifiedSince("token", "2026-01-01T00:00:00.000Z", 10);

    expect(results.map((r) => r.id)).toEqual(["c-1", "c-2"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops paginating once maxContacts is reached", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ results: [{ id: "c-1" }, { id: "c-2" }], paging: { next: { after: "cursor-1" } } })
    );
    vi.stubGlobal("fetch", fetchMock);

    const results = await searchHubSpotContactsModifiedSince("token", "2026-01-01T00:00:00.000Z", 2);

    expect(results).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("searchHubSpotDealsModifiedSince", () => {
  it("posts a GTE filter for deals too", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [{ id: "d-1" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const results = await searchHubSpotDealsModifiedSince("token", "2026-01-01T00:00:00.000Z", 10);

    expect(results).toEqual([{ id: "d-1" }]);
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/crm/v3/objects/deals/search");
  });
});

describe("updateHubSpotContact / updateHubSpotDeal", () => {
  it("PATCHes the single contact record by id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "c-1" }));
    vi.stubGlobal("fetch", fetchMock);

    await updateHubSpotContact("token", "c-1", { firstname: "Ada" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/crm/v3/objects/contacts/c-1");
    expect((init as RequestInit).method).toBe("PATCH");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ properties: { firstname: "Ada" } });
  });

  it("PATCHes the single deal record by id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "d-1" }));
    vi.stubGlobal("fetch", fetchMock);

    await updateHubSpotDeal("token", "d-1", { amount: "500" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/crm/v3/objects/deals/d-1");
    expect((init as RequestInit).method).toBe("PATCH");
  });

  it("throws when HubSpot returns a non-2xx status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ message: "nope" }, false, 403)));
    await expect(updateHubSpotContact("token", "c-1", {})).rejects.toThrow(/403/);
  });
});

describe("isHubSpotRetryableError", () => {
  it("treats 429 as retryable", () => {
    expect(isHubSpotRetryableError(new Error("HubSpot API /x failed: 429 rate limited"))).toBe(true);
  });

  it("treats 5xx as retryable", () => {
    expect(isHubSpotRetryableError(new Error("HubSpot API /x failed: 503 unavailable"))).toBe(true);
  });

  it("treats 4xx other than 429 as non-retryable", () => {
    expect(isHubSpotRetryableError(new Error("HubSpot API /x failed: 403 forbidden"))).toBe(false);
    expect(isHubSpotRetryableError(new Error("HubSpot API /x failed: 400 bad request"))).toBe(false);
  });

  it("treats an error with no recognizable status as non-retryable", () => {
    expect(isHubSpotRetryableError(new Error("network error"))).toBe(false);
    expect(isHubSpotRetryableError("not an Error instance")).toBe(false);
  });
});
