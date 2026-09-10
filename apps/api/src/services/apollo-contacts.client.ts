import { HttpError } from "../utils/http.js";

const APOLLO_BASE = "https://api.apollo.io/v1";

export interface ApolloListSummary {
  id: string;
  name: string;
  contactCount: number;
}

export interface ApolloContactRecord {
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  title?: string;
  phone?: string;
  linkedinUrl?: string;
  companyName?: string;
  companyDomain?: string;
}

async function apolloFetch<T>(path: string, apiKey: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${APOLLO_BASE}${path}`, {
    ...init,
    method: init?.method ?? "POST",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    body: init?.body ?? JSON.stringify({ api_key: apiKey }),
  });
  if (res.status === 401 || res.status === 403) {
    throw new HttpError("apollo_unauthorized", 401, { detail: "Apollo rejected the API key" });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HttpError("apollo_request_failed", 502, { status: res.status, detail: text.slice(0, 500) });
  }
  return res.json() as Promise<T>;
}

interface ApolloLabel {
  id: string;
  name: string;
  count?: number;
}

interface ApolloContact {
  id: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  title?: string;
  phone_numbers?: { raw_number?: string }[];
  linkedin_url?: string;
  organization_name?: string;
  organization?: { primary_domain?: string; website_url?: string };
}

/**
 * R22.1 (built here, not previously shipped despite the "existing Apollo import" framing —
 * see R22.2's kickoff note) — list the workspace's Apollo contact lists ("Labels" in Apollo's
 * own API). Same honest-caveat posture as `apollo-import.service.ts`'s sequence import: this
 * targets the documented v1 `labels` endpoint; plan-tier differences can still 401/404.
 */
export async function listApolloLists(apiKey: string): Promise<ApolloListSummary[]> {
  const data = await apolloFetch<{ labels?: ApolloLabel[] }>("/labels", apiKey, { method: "GET" });
  return (data.labels ?? []).map((l) => ({ id: l.id, name: l.name, contactCount: l.count ?? 0 }));
}

function mapContact(c: ApolloContact): ApolloContactRecord {
  return {
    id: c.id,
    firstName: c.first_name,
    lastName: c.last_name,
    email: c.email,
    title: c.title,
    phone: c.phone_numbers?.[0]?.raw_number,
    linkedinUrl: c.linkedin_url,
    companyName: c.organization_name,
    companyDomain: c.organization?.primary_domain ?? extractDomain(c.organization?.website_url),
  };
}

function extractDomain(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/** Contacts in one Apollo list, or the workspace's whole contact book when `listId` is omitted. */
export async function listApolloContacts(
  apiKey: string,
  listId: string | undefined,
  maxContacts = 500
): Promise<ApolloContactRecord[]> {
  const contacts: ApolloContactRecord[] = [];
  let page = 1;
  const perPage = 100;

  while (contacts.length < maxContacts) {
    const data = await apolloFetch<{ contacts?: ApolloContact[] }>("/contacts/search", apiKey, {
      body: JSON.stringify({
        api_key: apiKey,
        page,
        per_page: perPage,
        ...(listId ? { label_ids: [listId] } : {}),
      }),
    });
    const batch = data.contacts ?? [];
    if (!batch.length) break;
    contacts.push(...batch.map(mapContact));
    if (batch.length < perPage) break;
    page += 1;
  }

  return contacts.slice(0, maxContacts);
}
