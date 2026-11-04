export interface CrmAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  portalId?: string;
}

export interface CrmWebhookRequest {
  method: string;
  uri?: string | null;
  rawBody: string;
  headers: Record<string, unknown>;
  nowMs?: number;
}

export interface CrmWebhookEvent {
  eventId: string;
  portalId?: string;
  subscriptionType?: string;
  objectType: "contact" | "deal" | "company" | "unknown";
  objectId: string;
  propertyName?: string;
  propertyValue?: unknown;
  occurredAt?: string;
}

export interface CrmContactRecord {
  id: string;
  properties: Record<string, unknown>;
}

export interface CrmDealRecord {
  id: string;
  properties: Record<string, unknown>;
}

export interface CrmRateLimitState {
  isRateLimited: boolean;
  lastRateLimitedAt: string | null;
  limitedUntil: string | null;
  retryAfterMs: number | null;
}

export interface CrmConnectorAuth {
  buildAuthorizeUrl(params: { clientId: string; redirectUri: string; state: string }): string;
  exchangeCode(params: { clientId: string; clientSecret: string; redirectUri: string; code: string }): Promise<CrmAuthTokens>;
  refreshToken(params: { clientId: string; clientSecret: string; refreshToken: string }): Promise<CrmAuthTokens>;
  getPortalId(accessToken: string): Promise<string>;
}

export interface CrmConnectorWebhook {
  verifySignature(secret: string, req: CrmWebhookRequest): boolean;
  parseEvents(rawBody: string): CrmWebhookEvent[];
}

export interface CrmConnectorClient {
  searchContactsModifiedSince(token: string, sinceIso: string, limit?: number): Promise<CrmContactRecord[]>;
  searchDealsModifiedSince(token: string, sinceIso: string, limit?: number): Promise<CrmDealRecord[]>;
  updateContact(token: string, externalId: string, patch: Record<string, unknown>): Promise<void>;
  updateDeal(token: string, externalId: string, patch: Record<string, unknown>): Promise<void>;
  getRateLimitState(): CrmRateLimitState;
  isRetryableError(err: unknown): boolean;
  isGrantExpiredError(err: unknown): boolean;
}

export interface CrmConnector {
  readonly provider: string;
  readonly label: string;
  readonly auth: CrmConnectorAuth;
  readonly webhook: CrmConnectorWebhook;
  readonly client: CrmConnectorClient;
}

