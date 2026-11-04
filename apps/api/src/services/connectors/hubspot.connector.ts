import type {
  CrmConnector,
  CrmWebhookRequest,
  CrmWebhookEvent,
  CrmContactRecord,
  CrmDealRecord,
  CrmRateLimitState,
} from "../crm-connector.interface.js";
import {
  buildHubSpotAuthorizeUrl,
  exchangeHubSpotCode,
  refreshHubSpotToken,
  fetchHubSpotPortalId,
  searchHubSpotContactsModifiedSince,
  searchHubSpotDealsModifiedSince,
  updateHubSpotContact,
  updateHubSpotDeal,
  getHubSpotRateLimitState,
  isHubSpotRetryableError,
} from "../hubspot.client.js";
import { isCrmGrantExpiredError } from "../crm-auth-lifecycle.service.js";
import { verifyHubSpotWebhook } from "../crm-hubspot-webhook.service.js";

export const hubspotConnector: CrmConnector = {
  provider: "hubspot",
  label: "HubSpot",

  auth: {
    buildAuthorizeUrl(params) {
      return buildHubSpotAuthorizeUrl(params);
    },
    async exchangeCode(params) {
      return exchangeHubSpotCode(params);
    },
    async refreshToken(params) {
      return refreshHubSpotToken(params);
    },
    async getPortalId(accessToken: string) {
      return fetchHubSpotPortalId(accessToken);
    },
  },

  webhook: {
    verifySignature(secret: string, req: CrmWebhookRequest): boolean {
      return verifyHubSpotWebhook(secret, {
        method: req.method,
        uri: req.uri ?? null,
        rawBody: req.rawBody,
        headers: req.headers as Record<string, string | string[] | undefined>,
        nowMs: req.nowMs,
      });
    },

    parseEvents(rawBody: string): CrmWebhookEvent[] {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return [];
      }
      if (!Array.isArray(parsed)) return [];

      return parsed.map((e: Record<string, unknown>) => {
        let objectType: "contact" | "deal" | "company" | "unknown" = "unknown";
        const sub = String(e.subscriptionType ?? "");
        if (sub.startsWith("contact.")) objectType = "contact";
        else if (sub.startsWith("deal.")) objectType = "deal";
        else if (sub.startsWith("company.")) objectType = "company";

        return {
          eventId: String(e.eventId ?? ""),
          portalId: e.portalId != null ? String(e.portalId) : undefined,
          subscriptionType: typeof e.subscriptionType === "string" ? e.subscriptionType : undefined,
          objectType,
          objectId: String(e.objectId ?? ""),
          propertyName: typeof e.propertyName === "string" ? e.propertyName : undefined,
          propertyValue: e.propertyValue,
          occurredAt: e.occurredAt ? new Date(Number(e.occurredAt)).toISOString() : undefined,
        };
      });
    },
  },

  client: {
    async searchContactsModifiedSince(token: string, sinceIso: string, limit?: number): Promise<CrmContactRecord[]> {
      const records = await searchHubSpotContactsModifiedSince(token, sinceIso, limit);
      return records.map((r) => ({
        id: r.id,
        properties: (r.properties ?? {}) as Record<string, unknown>,
      }));
    },

    async searchDealsModifiedSince(token: string, sinceIso: string, limit?: number): Promise<CrmDealRecord[]> {
      const records = await searchHubSpotDealsModifiedSince(token, sinceIso, limit);
      return records.map((r) => ({
        id: r.id,
        properties: (r.properties ?? {}) as Record<string, unknown>,
      }));
    },

    async updateContact(token: string, externalId: string, patch: Record<string, unknown>): Promise<void> {
      const stringProps: Record<string, string> = {};
      for (const [k, v] of Object.entries(patch)) {
        if (v != null) stringProps[k] = String(v);
      }
      return updateHubSpotContact(token, externalId, stringProps);
    },

    async updateDeal(token: string, externalId: string, patch: Record<string, unknown>): Promise<void> {
      const stringProps: Record<string, string> = {};
      for (const [k, v] of Object.entries(patch)) {
        if (v != null) stringProps[k] = String(v);
      }
      return updateHubSpotDeal(token, externalId, stringProps);
    },

    getRateLimitState(): CrmRateLimitState {
      return getHubSpotRateLimitState();
    },

    isRetryableError(err: unknown): boolean {
      return isHubSpotRetryableError(err);
    },

    isGrantExpiredError(err: unknown): boolean {
      return isCrmGrantExpiredError(err);
    },
  },
};

