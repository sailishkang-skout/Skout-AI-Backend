import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const HUBSPOT_AUTH_URL = "https://app.hubspot.com/oauth/authorize";
const HUBSPOT_TOKEN_URL = "https://api.hubapi.com/oauth/v1/token";
const HUBSPOT_API = "https://api.hubapi.com";

export interface HubSpotTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  portalId?: string;
}

export function buildHubSpotAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(HUBSPOT_AUTH_URL);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set(
    "scope",
    "oauth crm.objects.contacts.read crm.objects.contacts.write crm.objects.deals.read crm.objects.deals.write crm.lists.read"
  );
  url.searchParams.set("state", params.state);
  return url.toString();
}

export async function exchangeHubSpotCode(params: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<HubSpotTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
    code: params.code,
  });

  const res = await fetch(HUBSPOT_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot token exchange failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString(),
  };
}

export async function refreshHubSpotToken(params: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<HubSpotTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: params.clientId,
    client_secret: params.clientSecret,
    refresh_token: params.refreshToken,
  });

  const res = await fetch(HUBSPOT_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot token refresh failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString(),
  };
}

export interface HubSpotContactInput {
  prospectId: string;
  email?: string;
  firstname?: string;
  lastname?: string;
  company?: string;
  jobtitle?: string;
  hubspotContactId?: string;
}

export interface HubSpotUpsertResult {
  upserted: number;
  created: number;
  updated: number;
  mappings: Array<{ prospectId: string; hubspotContactId: string }>;
  errors: string[];
}

function contactProperties(c: HubSpotContactInput): Record<string, string> {
  const props: Record<string, string> = {};
  if (c.email) props.email = c.email;
  if (c.firstname) props.firstname = c.firstname;
  if (c.lastname) props.lastname = c.lastname;
  if (c.company) props.company = c.company;
  if (c.jobtitle) props.jobtitle = c.jobtitle;
  return props;
}

export class HubSpotRateLimitError extends Error {
  readonly status = 429;
  readonly retryAfterMs: number;
  readonly limitedUntil: Date;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = "HubSpotRateLimitError";
    this.retryAfterMs = retryAfterMs;
    this.limitedUntil = new Date(Date.now() + retryAfterMs);
  }
}

export interface HubSpotRateLimitState {
  isRateLimited: boolean;
  lastRateLimitedAt: string | null;
  limitedUntil: string | null;
  retryAfterMs: number | null;
}

const EMPTY_RATE_LIMIT_STATE: HubSpotRateLimitState = {
  isRateLimited: false,
  lastRateLimitedAt: null,
  limitedUntil: null,
  retryAfterMs: null,
};

/**
 * Rate-limit state per access token (that is, per HubSpot connection), so one portal's 429 does
 * not hold back every other workspace. In-process only; the sync paths copy it onto the
 * connection row (settings.rateLimit) so the health API sees it from any process.
 */
const rateLimitStates = new Map<string, HubSpotRateLimitState>();
const DEFAULT_RATE_LIMIT_KEY = "default";

/** A short, non-reversible key for an access token. */
export function hubspotRateLimitKey(accessToken: string | null | undefined): string {
  if (!accessToken) return DEFAULT_RATE_LIMIT_KEY;
  return createHash("sha256").update(accessToken).digest("hex").slice(0, 16);
}

export function recordHubSpotRateLimit(retryAfterMs: number, now = Date.now(), key = DEFAULT_RATE_LIMIT_KEY): void {
  rateLimitStates.set(key, {
    isRateLimited: true,
    lastRateLimitedAt: new Date(now).toISOString(),
    limitedUntil: new Date(now + retryAfterMs).toISOString(),
    retryAfterMs,
  });
}

export function getHubSpotRateLimitState(now = Date.now(), key = DEFAULT_RATE_LIMIT_KEY): HubSpotRateLimitState {
  const state = rateLimitStates.get(key) ?? EMPTY_RATE_LIMIT_STATE;
  if (state.isRateLimited && state.limitedUntil && new Date(state.limitedUntil).getTime() <= now) {
    return { ...state, isRateLimited: false };
  }
  return { ...state };
}

export function resetHubSpotRateLimitState(): void {
  rateLimitStates.clear();
}

export function parseRetryAfter(header: string | null | undefined, fallbackMs = 1000): number {
  if (!header) return fallbackMs;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) {
    const diff = dateMs - Date.now();
    return diff > 0 ? diff : fallbackMs;
  }
  return fallbackMs;
}

export interface HubSpotRequestOptions extends RequestInit {
  maxRetries?: number;
  sleepImpl?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

function bearerToken(headers: HeadersInit | undefined): string | null {
  if (!headers) return null;
  const value = new Headers(headers).get("authorization");
  return value?.startsWith("Bearer ") ? value.slice(7) : null;
}

/** Longest Retry-After honoured inside one request; a longer one fails the call for a later retry. */
const MAX_IN_REQUEST_WAIT_MS = 60_000;

export async function hubspotFetchWithBackoff(url: string, init?: HubSpotRequestOptions): Promise<Response> {
  const { maxRetries: maxRetriesOpt, sleepImpl, fetchImpl, ...requestInit } = init ?? {};
  const maxRetries = maxRetriesOpt ?? 3;
  const sleep = sleepImpl ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const doFetch = fetchImpl ?? fetch;
  const key = hubspotRateLimitKey(bearerToken(requestInit.headers));

  // This connection is still inside a window HubSpot told us to wait: wait it out first.
  const currentState = getHubSpotRateLimitState(Date.now(), key);
  if (currentState.isRateLimited && currentState.limitedUntil) {
    const waitMs = new Date(currentState.limitedUntil).getTime() - Date.now();
    if (waitMs > 0 && waitMs <= MAX_IN_REQUEST_WAIT_MS) {
      await sleep(waitMs);
    }
  }

  let attempt = 0;
  while (true) {
    const res = await doFetch(url, requestInit);
    if (res.status === 429) {
      const retryAfterHeader =
        typeof res.headers?.get === "function"
          ? res.headers.get("retry-after")
          : (res.headers as unknown as Record<string, string> | undefined)?.["retry-after"];
      const waitMs = parseRetryAfter(retryAfterHeader, Math.min(1000 * 2 ** attempt, 30_000));
      recordHubSpotRateLimit(waitMs, Date.now(), key);

      if (attempt < maxRetries && waitMs <= MAX_IN_REQUEST_WAIT_MS) {
        attempt++;
        await sleep(waitMs);
        continue;
      }
      // Nothing was written: the caller's retry (checkpoint or outbound-write lease) repeats it later.
      const text = await res.text().catch(() => "");
      throw new HubSpotRateLimitError(`HubSpot request to ${url} rate limited (429) after ${attempt} retries: ${text}`, waitMs);
    }
    return res;
  }
}

const BATCH_SIZE = 100;

async function hubspotBatchRequest<T>(
  accessToken: string,
  path: string,
  body: unknown,
  options?: HubSpotRequestOptions
): Promise<T> {
  const res = await hubspotFetchWithBackoff(`${HUBSPOT_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    ...options,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot ${path} failed: ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

/** Idempotent push: update by stored HubSpot id, else upsert by email. */
export async function batchUpsertHubSpotContacts(
  accessToken: string,
  contacts: HubSpotContactInput[]
): Promise<HubSpotUpsertResult> {
  const mappings: Array<{ prospectId: string; hubspotContactId: string }> = [];
  const errors: string[] = [];
  let created = 0;
  let updated = 0;

  const byId = contacts.filter((c) => c.hubspotContactId?.trim());
  const byEmail = contacts.filter((c) => c.email?.trim() && !c.hubspotContactId?.trim());

  for (let i = 0; i < byId.length; i += BATCH_SIZE) {
    const chunk = byId.slice(i, i + BATCH_SIZE);
    try {
      const data = await hubspotBatchRequest<{ results?: Array<{ id: string }> }>(
        accessToken,
        "/crm/v3/objects/contacts/batch/update",
        {
          inputs: chunk.map((c) => ({
            id: c.hubspotContactId!,
            properties: contactProperties(c),
          })),
        }
      );
      const results = data.results ?? [];
      updated += results.length;
      chunk.forEach((c, idx) => {
        const id = results[idx]?.id ?? c.hubspotContactId!;
        mappings.push({ prospectId: c.prospectId, hubspotContactId: id });
      });
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  for (let i = 0; i < byEmail.length; i += BATCH_SIZE) {
    const chunk = byEmail.slice(i, i + BATCH_SIZE);
    try {
      const data = await hubspotBatchRequest<{ results?: Array<{ id: string }> }>(
        accessToken,
        "/crm/v3/objects/contacts/batch/upsert",
        {
          inputs: chunk.map((c) => ({
            idProperty: "email",
            properties: contactProperties(c),
          })),
        }
      );
      const results = data.results ?? [];
      created += results.length;
      chunk.forEach((c, idx) => {
        const id = results[idx]?.id;
        if (id) mappings.push({ prospectId: c.prospectId, hubspotContactId: id });
      });
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return {
    upserted: mappings.length,
    created,
    updated,
    mappings,
    errors,
  };
}

/** @deprecated Use batchUpsertHubSpotContacts for idempotent export. */
export async function batchCreateHubSpotContacts(
  accessToken: string,
  contacts: HubSpotContactInput[]
): Promise<{ created: number; errors: string[] }> {
  const inputs = contacts
    .filter((c) => c.email)
    .map((c) => ({
      properties: {
        email: c.email!,
        ...(c.firstname ? { firstname: c.firstname } : {}),
        ...(c.lastname ? { lastname: c.lastname } : {}),
        ...(c.company ? { company: c.company } : {}),
        ...(c.jobtitle ? { jobtitle: c.jobtitle } : {}),
      },
    }));

  if (!inputs.length) {
    return { created: 0, errors: ["No contacts with email addresses"] };
  }

  const data = await hubspotBatchRequest<{ results?: unknown[] }>(
    accessToken,
    "/crm/v3/objects/contacts/batch/create",
    { inputs }
  );
  return { created: data.results?.length ?? inputs.length, errors: [] };
}

const CONTACT_PROPERTIES = [
  "email",
  "firstname",
  "lastname",
  "jobtitle",
  "company",
  "phone",
  "hs_lastmodifieddate",
] as const;

export interface HubSpotContactProperties {
  email?: string;
  firstname?: string;
  lastname?: string;
  jobtitle?: string;
  company?: string;
  phone?: string;
  /** §8.12 Task ADI-10 — provider-side last-modified timestamp, used as the incremental-sync
   * cursor and as the conflict-detection signal for outbound push-back. */
  hs_lastmodifieddate?: string;
}

export interface HubSpotContactRecord {
  id: string;
  properties: HubSpotContactProperties;
}

export interface HubSpotListSummary {
  listId: string;
  name: string;
  size: number;
}

async function hubspotFetch<T>(
  accessToken: string,
  path: string,
  init?: RequestInit,
  options?: HubSpotRequestOptions
): Promise<T> {
  const res = await hubspotFetchWithBackoff(`${HUBSPOT_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...options,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot API ${path} failed: ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

export async function searchHubSpotLists(accessToken: string): Promise<HubSpotListSummary[]> {
  const data = await hubspotFetch<{
    lists?: Array<{
      listId: string;
      name: string;
      objectTypeId?: string;
      additionalProperties?: { hs_list_size?: string };
    }>;
  }>(accessToken, "/crm/v3/lists/search", {
    method: "POST",
    body: JSON.stringify({
      query: "",
      objectTypeId: "0-1",
      count: 100,
      offset: 0,
      processingTypes: ["MANUAL", "SNAPSHOT", "DYNAMIC"],
    }),
  });

  return (data.lists ?? [])
    .filter((list) => !list.objectTypeId || list.objectTypeId === "0-1")
    .map((list) => ({
      listId: list.listId,
      name: list.name,
      size: Number(list.additionalProperties?.hs_list_size ?? 0),
    }));
}

export function isHubSpotMissingScopeError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("MISSING_SCOPES") || msg.includes("crm.lists.read");
}

async function batchReadHubSpotContacts(
  accessToken: string,
  ids: string[]
): Promise<HubSpotContactRecord[]> {
  const results: HubSpotContactRecord[] = [];
  const chunkSize = 100;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const data = await hubspotFetch<{ results?: HubSpotContactRecord[] }>(
      accessToken,
      "/crm/v3/objects/contacts/batch/read",
      {
        method: "POST",
        body: JSON.stringify({
          properties: CONTACT_PROPERTIES,
          inputs: chunk.map((id) => ({ id })),
        }),
      }
    );
    results.push(...(data.results ?? []));
  }
  return results;
}

export async function fetchHubSpotListContactIds(
  accessToken: string,
  listId: string,
  maxContacts = 500
): Promise<string[]> {
  const ids: string[] = [];
  let after: string | undefined;

  while (ids.length < maxContacts) {
    const qs = new URLSearchParams({ limit: "100" });
    if (after) qs.set("after", after);
    const data = await hubspotFetch<{
      results?: Array<{ recordId: string }>;
      paging?: { next?: { after?: string } };
    }>(accessToken, `/crm/v3/lists/${listId}/memberships?${qs}`);

    for (const row of data.results ?? []) {
      if (row.recordId) ids.push(row.recordId);
      if (ids.length >= maxContacts) break;
    }

    after = data.paging?.next?.after;
    if (!after || !(data.results?.length)) break;
  }

  return ids;
}

export async function fetchAllHubSpotContacts(
  accessToken: string,
  maxContacts = 500
): Promise<HubSpotContactRecord[]> {
  const results: HubSpotContactRecord[] = [];
  let after: string | undefined;

  while (results.length < maxContacts) {
    const qs = new URLSearchParams({
      limit: "100",
      properties: CONTACT_PROPERTIES.join(","),
    });
    if (after) qs.set("after", after);

    const data = await hubspotFetch<{
      results?: HubSpotContactRecord[];
      paging?: { next?: { after?: string } };
    }>(accessToken, `/crm/v3/objects/contacts?${qs}`);

    results.push(...(data.results ?? []));
    if (results.length >= maxContacts) break;

    after = data.paging?.next?.after;
    if (!after || !(data.results?.length)) break;
  }

  return results.slice(0, maxContacts);
}

export async function fetchHubSpotListContacts(
  accessToken: string,
  listId: string,
  maxContacts = 500
): Promise<HubSpotContactRecord[]> {
  const ids = await fetchHubSpotListContactIds(accessToken, listId, maxContacts);
  if (!ids.length) return [];
  return batchReadHubSpotContacts(accessToken, ids);
}

export interface HubSpotDealRecord {
  id: string;
  properties?: {
    dealname?: string;
    amount?: string;
    closedate?: string;
    dealstage?: string;
    pipeline?: string;
    /** §8.12 Task ADI-10 — see HubSpotContactProperties.hs_lastmodifieddate. */
    hs_lastmodifieddate?: string;
  };
}

const DEAL_PROPERTIES = ["dealname", "amount", "closedate", "dealstage", "pipeline", "hs_lastmodifieddate"] as const;

export async function fetchAllHubSpotDeals(
  accessToken: string,
  maxDeals = 200
): Promise<HubSpotDealRecord[]> {
  const results: HubSpotDealRecord[] = [];
  let after: string | undefined;

  while (results.length < maxDeals) {
    const qs = new URLSearchParams({
      limit: "100",
      properties: DEAL_PROPERTIES.join(","),
    });
    if (after) qs.set("after", after);

    const data = await hubspotFetch<{
      results?: HubSpotDealRecord[];
      paging?: { next?: { after?: string } };
    }>(accessToken, `/crm/v3/objects/deals?${qs}`);

    results.push(...(data.results ?? []));
    if (results.length >= maxDeals) break;
    after = data.paging?.next?.after;
    if (!after || !(data.results?.length)) break;
  }

  return results.slice(0, maxDeals);
}

export async function fetchHubSpotDeal(
  accessToken: string,
  dealId: string
): Promise<HubSpotDealRecord | null> {
  const qs = new URLSearchParams({ properties: DEAL_PROPERTIES.join(",") });
  try {
    return await hubspotFetch<HubSpotDealRecord>(
      accessToken,
      `/crm/v3/objects/deals/${encodeURIComponent(dealId)}?${qs}`
    );
  } catch {
    return null;
  }
}

/**
 * §8.12 Task ADI-10 — incremental pull via HubSpot's search API, filtered on
 * `hs_lastmodifieddate >= sinceIso` and sorted ascending so the last page's timestamp is a safe
 * next cursor. Unlike `fetchAllHubSpotContacts`/`fetchAllHubSpotDeals` (plain list, no filter),
 * this only returns records that changed since the caller's checkpoint.
 */
async function searchHubSpotModifiedSince<T>(
  accessToken: string,
  objectType: "contacts" | "deals",
  properties: readonly string[],
  sinceIso: string,
  max: number
): Promise<T[]> {
  const results: T[] = [];
  let after: string | undefined;

  while (results.length < max) {
    const data = await hubspotBatchRequest<{
      results?: T[];
      paging?: { next?: { after?: string } };
    }>(accessToken, `/crm/v3/objects/${objectType}/search`, {
      filterGroups: [
        { filters: [{ propertyName: "hs_lastmodifieddate", operator: "GTE", value: sinceIso }] },
      ],
      sorts: [{ propertyName: "hs_lastmodifieddate", direction: "ASCENDING" }],
      properties,
      limit: 100,
      ...(after ? { after } : {}),
    });

    results.push(...(data.results ?? []));
    if (results.length >= max) break;
    after = data.paging?.next?.after;
    if (!after || !(data.results?.length)) break;
  }

  return results.slice(0, max);
}

export async function searchHubSpotContactsModifiedSince(
  accessToken: string,
  sinceIso: string,
  maxContacts = 500
): Promise<HubSpotContactRecord[]> {
  return searchHubSpotModifiedSince<HubSpotContactRecord>(
    accessToken,
    "contacts",
    CONTACT_PROPERTIES,
    sinceIso,
    maxContacts
  );
}

export async function searchHubSpotDealsModifiedSince(
  accessToken: string,
  sinceIso: string,
  maxDeals = 500
): Promise<HubSpotDealRecord[]> {
  return searchHubSpotModifiedSince<HubSpotDealRecord>(accessToken, "deals", DEAL_PROPERTIES, sinceIso, maxDeals);
}

/** §8.12 Task ADI-10 — single-record push-back write, used once a HubSpot object id is already
 * known (via crm_native_links) so there's no ambiguity about which record to update. */
export async function updateHubSpotContact(
  accessToken: string,
  hubspotContactId: string,
  properties: Record<string, string>
): Promise<void> {
  await hubspotFetch(accessToken, `/crm/v3/objects/contacts/${encodeURIComponent(hubspotContactId)}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
}

export async function updateHubSpotDeal(
  accessToken: string,
  hubspotDealId: string,
  properties: Record<string, string>
): Promise<void> {
  await hubspotFetch(accessToken, `/crm/v3/objects/deals/${encodeURIComponent(hubspotDealId)}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
}

/** COPS-09 — one record's current values, used to show both sides of an outbound conflict. */
export async function fetchHubSpotObjectProperties(
  accessToken: string,
  objectType: "contacts" | "deals",
  objectId: string,
  properties: readonly string[]
): Promise<Record<string, string | null>> {
  const qs = new URLSearchParams({ properties: properties.join(",") });
  const data = await hubspotFetch<{ properties?: Record<string, string | null> }>(
    accessToken,
    `/crm/v3/objects/${objectType}/${encodeURIComponent(objectId)}?${qs}`
  );
  return data.properties ?? {};
}

export interface HubSpotPipeline {
  id: string;
  label: string;
  stages: Array<{ id: string; label: string }>;
}

/** COPS-09 — the portal's deal pipelines and stages, for the stage map. */
export async function fetchHubSpotDealPipelines(accessToken: string): Promise<HubSpotPipeline[]> {
  const data = await hubspotFetch<{ results?: Array<{ id?: string; label?: string; stages?: Array<{ id?: string; label?: string }> }> }>(
    accessToken,
    "/crm/v3/pipelines/deals"
  );
  return (data.results ?? [])
    .filter((p): p is { id: string; label?: string; stages?: Array<{ id?: string; label?: string }> } => typeof p.id === "string")
    .map((p) => ({
      id: p.id,
      label: p.label ?? p.id,
      stages: (p.stages ?? []).filter((st) => typeof st.id === "string").map((st) => ({ id: st.id!, label: st.label ?? st.id! })),
    }));
}

/** COPS-09 — the property names the portal defines for an object type, for schema-drift checks. */
export async function fetchHubSpotPropertyNames(accessToken: string, objectType: "contacts" | "deals"): Promise<string[]> {
  const data = await hubspotFetch<{ results?: Array<{ name?: string }> }>(accessToken, `/crm/v3/properties/${objectType}`);
  return (data.results ?? []).map((p) => p.name).filter((n): n is string => typeof n === "string");
}

/** §8.12 Task ADI-10 — 429 (rate limit) and 5xx are worth retrying via the outbound-write
 * worker's lease-expiry/reclaim cycle; anything else (4xx validation, auth, missing scope) is
 * not going to succeed on a bare retry. Matches the existing heuristic-on-error-message style
 * of `isHubSpotMissingScopeError` above — `hubspotFetch`/`hubspotBatchRequest` only throw a
 * generic `Error`, there's no typed HTTP-status error class to inspect instead. */
export function isHubSpotRetryableError(err: unknown): boolean {
  if (err instanceof HubSpotRateLimitError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  const match = msg.match(/failed: (\d{3})/);
  if (!match) return false;
  const status = Number(match[1]);
  return status === 429 || status >= 500;
}

/**
 * COPS-09: the HubSpot account (portal) id the token belongs to, from HubSpot's token info
 * endpoint. Webhook events carry this id, so it is what maps an event to a Skout workspace.
 */
export async function fetchHubSpotPortalId(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(`https://api.hubapi.com/oauth/v1/access-tokens/${encodeURIComponent(accessToken)}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HubSpot token info failed: ${res.status}`);
  const body = (await res.json()) as { hub_id?: number | string };
  if (body.hub_id == null || body.hub_id === "") throw new Error("HubSpot token info has no hub_id");
  return String(body.hub_id);
}

/** Five minutes either way, as HubSpot recommends for v3 signatures. */
export const HUBSPOT_SIGNATURE_MAX_AGE_MS = 5 * 60_000;

/**
 * HubSpot webhook v3 signature: base64 HMAC-SHA256, keyed with the client secret, of
 * method + full request URI + body + timestamp (X-HubSpot-Request-Timestamp, in ms). Unlike v1 it
 * covers the URL and expires, so a captured request cannot be replayed later or elsewhere.
 */
export function verifyHubSpotWebhookSignatureV3(
  clientSecret: string,
  input: { method: string; uri: string; rawBody: string; timestamp: string | undefined; signature: string | undefined; nowMs?: number }
): boolean {
  if (!input.signature || !input.timestamp) return false;
  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts) || Math.abs((input.nowMs ?? Date.now()) - ts) > HUBSPOT_SIGNATURE_MAX_AGE_MS) return false;
  const expected = createHmac("sha256", clientSecret).update(`${input.method}${input.uri}${input.rawBody}${input.timestamp}`, "utf8").digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(input.signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** HubSpot webhook v1 signature: sha256(clientSecret + body). */
export function verifyHubSpotWebhookSignature(
  clientSecret: string,
  rawBody: string,
  signatureHeader: string | undefined
): boolean {
  if (!signatureHeader) return false;
  const expected = createHash("sha256").update(clientSecret + rawBody, "utf8").digest("hex");
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(signatureHeader);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return expected === signatureHeader;
  }
}
