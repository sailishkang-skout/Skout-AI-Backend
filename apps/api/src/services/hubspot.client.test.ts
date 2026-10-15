import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HubSpotRateLimitError,
  getHubSpotRateLimitState,
  hubspotFetchWithBackoff,
  isHubSpotRetryableError,
  parseRetryAfter,
  recordHubSpotRateLimit,
  resetHubSpotRateLimitState,
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

  it("treats HubSpotRateLimitError as retryable", () => {
    expect(isHubSpotRetryableError(new HubSpotRateLimitError("rate limited", 1000))).toBe(true);
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

describe("parseRetryAfter", () => {
  it("parses integer seconds into milliseconds", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("parses HTTP date string into milliseconds from now", () => {
    const futureDate = new Date(Date.now() + 5000).toUTCString();
    const parsed = parseRetryAfter(futureDate);
    expect(parsed).toBeGreaterThanOrEqual(4000);
    expect(parsed).toBeLessThanOrEqual(6000);
  });

  it("falls back to default when header is missing or unparseable", () => {
    expect(parseRetryAfter(undefined, 2500)).toBe(2500);
    expect(parseRetryAfter(null, 1500)).toBe(1500);
    expect(parseRetryAfter("invalid-date", 1000)).toBe(1000);
  });
});

describe("HubSpot rate limit state tracking", () => {
  beforeEach(() => {
    resetHubSpotRateLimitState();
  });

  it("records rate limit state and marks isRateLimited true until expiry", () => {
    const baseNow = 1_700_000_000_000;
    recordHubSpotRateLimit(5000, baseNow);

    const activeState = getHubSpotRateLimitState(baseNow + 1000);
    expect(activeState.isRateLimited).toBe(true);
    expect(activeState.retryAfterMs).toBe(5000);
    expect(activeState.limitedUntil).toBe(new Date(baseNow + 5000).toISOString());

    const expiredState = getHubSpotRateLimitState(baseNow + 6000);
    expect(expiredState.isRateLimited).toBe(false);
  });
});

describe("hubspotFetchWithBackoff", () => {
  beforeEach(() => {
    resetHubSpotRateLimitState();
  });

  it("backs off on 429 using Retry-After and succeeds on subsequent try", async () => {
    const sleptMs: number[] = [];
    const sleepMock = vi.fn(async (ms: number) => {
      sleptMs.push(ms);
    });

    const mockResponse429 = {
      ok: false,
      status: 429,
      headers: {
        get: (h: string) => (h.toLowerCase() === "retry-after" ? "2" : null),
      },
      text: () => Promise.resolve("rate limit exceeded"),
    };

    const mockResponse200 = {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve({ ok: true }),
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse429)
      .mockResolvedValueOnce(mockResponse200);

    const res = await hubspotFetchWithBackoff("https://api.hubapi.com/test", {
      fetchImpl: fetchMock as unknown as typeof fetch,
      sleepImpl: sleepMock,
      maxRetries: 3,
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleptMs).toEqual([2000]);
    expect(getHubSpotRateLimitState().lastRateLimitedAt).not.toBeNull();
  });

  it("throws HubSpotRateLimitError when retries are exhausted", async () => {
    const sleepMock = vi.fn(async () => {});

    const mockResponse429 = {
      ok: false,
      status: 429,
      headers: {
        get: (h: string) => (h.toLowerCase() === "retry-after" ? "1" : null),
      },
      text: () => Promise.resolve("rate limit exceeded"),
    };

    const fetchMock = vi.fn().mockResolvedValue(mockResponse429);

    await expect(
      hubspotFetchWithBackoff("https://api.hubapi.com/test", {
        fetchImpl: fetchMock as unknown as typeof fetch,
        sleepImpl: sleepMock,
        maxRetries: 2,
      })
    ).rejects.toThrow(HubSpotRateLimitError);

    expect(fetchMock).toHaveBeenCalledTimes(3); // Initial + 2 retries
    expect(sleepMock).toHaveBeenCalledTimes(2);
  });
});

