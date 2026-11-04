import { describe, expect, it } from "vitest";
import {
  clearCrmConnectors,
  getCrmConnector,
  listCrmConnectors,
  registerCrmConnector,
} from "./crm-connector.registry.js";
import { hubspotConnector } from "./connectors/hubspot.connector.js";
import type { CrmConnector } from "./crm-connector.interface.js";

describe("CRM Connector Registry", () => {
  it("registers and retrieves the default hubspot connector case-insensitively", () => {
    const connector = getCrmConnector("hubspot");
    expect(connector).not.toBeNull();
    expect(connector?.provider).toBe("hubspot");
    expect(connector?.label).toBe("HubSpot");

    expect(getCrmConnector("HubSpot")?.provider).toBe("hubspot");
    expect(getCrmConnector("HUBSPOT")?.provider).toBe("hubspot");
  });

  it("returns null for unregistered providers", () => {
    expect(getCrmConnector("salesforce")).toBeNull();
  });

  it("lists all registered connectors", () => {
    const list = listCrmConnectors();
    expect(list.some((c) => c.provider === "hubspot")).toBe(true);
  });

  it("allows registering custom connectors", () => {
    const customConnector: CrmConnector = {
      provider: "mock_crm",
      label: "Mock CRM",
      auth: {
        buildAuthorizeUrl: () => "https://example.com/oauth",
        exchangeCode: async () => ({ accessToken: "a", refreshToken: "r", expiresAt: "2026-01-01" }),
        refreshToken: async () => ({ accessToken: "a", refreshToken: "r", expiresAt: "2026-01-01" }),
        getPortalId: async () => "portal-1",
      },
      webhook: {
        verifySignature: () => true,
        parseEvents: () => [],
      },
      client: {
        searchContactsModifiedSince: async () => [],
        searchDealsModifiedSince: async () => [],
        updateContact: async () => {},
        updateDeal: async () => {},
        getRateLimitState: () => ({ isRateLimited: false, lastRateLimitedAt: null, limitedUntil: null, retryAfterMs: null }),
        isRetryableError: () => false,
        isGrantExpiredError: () => false,
      },
    };

    registerCrmConnector(customConnector);
    expect(getCrmConnector("mock_crm")?.label).toBe("Mock CRM");
  });
});

describe("HubSpotConnector implementation", () => {
  it("builds authorization URL", () => {
    const url = hubspotConnector.auth.buildAuthorizeUrl({
      clientId: "client-123",
      redirectUri: "https://app.skout.com/callback",
      state: "state-abc",
    });
    expect(url).toContain("https://app.hubspot.com/oauth/authorize");
    expect(url).toContain("client_id=client-123");
    expect(url).toContain("state=state-abc");
  });

  it("parses webhook events and maps subscriptionType to objectType", () => {
    const payload = JSON.stringify([
      {
        eventId: 1001,
        portalId: 12345,
        subscriptionType: "contact.propertyChange",
        objectId: 555,
        propertyName: "firstname",
        propertyValue: "Jane",
        occurredAt: 1700000000000,
      },
      {
        eventId: 1002,
        portalId: 12345,
        subscriptionType: "deal.creation",
        objectId: 666,
      },
      {
        eventId: 1003,
        subscriptionType: "company.deletion",
        objectId: 777,
      },
    ]);

    const events = hubspotConnector.webhook.parseEvents(payload);
    expect(events).toHaveLength(3);

    expect(events[0]).toMatchObject({
      eventId: "1001",
      portalId: "12345",
      objectType: "contact",
      objectId: "555",
      propertyName: "firstname",
      propertyValue: "Jane",
    });

    expect(events[1]).toMatchObject({
      eventId: "1002",
      portalId: "12345",
      objectType: "deal",
      objectId: "666",
    });

    expect(events[2]).toMatchObject({
      eventId: "1003",
      objectType: "company",
      objectId: "777",
    });
  });

  it("handles malformed webhook JSON gracefully", () => {
    expect(hubspotConnector.webhook.parseEvents("not-json")).toEqual([]);
    expect(hubspotConnector.webhook.parseEvents("{}")).toEqual([]);
  });

  it("exposes retryable and grant expired error checks", () => {
    expect(hubspotConnector.client.isRetryableError(new Error("HubSpot API failed: 429"))).toBe(true);
    expect(hubspotConnector.client.isRetryableError(new Error("HubSpot API failed: 400"))).toBe(false);

    expect(hubspotConnector.client.isGrantExpiredError(new Error("BAD_REFRESH_TOKEN"))).toBe(true);
    expect(hubspotConnector.client.isGrantExpiredError(new Error("Network timeout"))).toBe(false);
  });
});

