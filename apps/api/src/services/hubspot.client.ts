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
    "oauth crm.objects.contacts.read crm.objects.contacts.write crm.lists.read"
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

const BATCH_SIZE = 100;

async function hubspotBatchRequest<T>(
  accessToken: string,
  path: string,
  body: unknown
): Promise<T> {
  const res = await fetch(`${HUBSPOT_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
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

  const res = await fetch(`${HUBSPOT_API}/crm/v3/objects/contacts/batch/create`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ inputs }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot contact create failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { results?: unknown[] };
  return { created: data.results?.length ?? inputs.length, errors: [] };
}

const CONTACT_PROPERTIES = [
  "email",
  "firstname",
  "lastname",
  "jobtitle",
  "company",
  "phone",
] as const;

export interface HubSpotContactProperties {
  email?: string;
  firstname?: string;
  lastname?: string;
  jobtitle?: string;
  company?: string;
  phone?: string;
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
  init?: RequestInit
): Promise<T> {
  const res = await fetch(`${HUBSPOT_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
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
