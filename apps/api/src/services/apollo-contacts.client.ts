import { HttpError } from "../utils/http.js";

export interface ApolloListSummary {
  id: string;
  name: string;
  contactCount: number;
}

export interface ApolloContactRecord {
  id: string;
  /** Apollo's id for the person, which is not the id of the saved contact. */
  personId?: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  email?: string;
  emailStatus?: string;
  title?: string;
  headline?: string;
  phone?: string;
  linkedinUrl?: string;
  companyName?: string;
  companyDomain?: string;
  companyWebsite?: string;
  city?: string;
  state?: string;
  country?: string;
  address?: string;
}

/** What reading Apollo can fail with. It carries the status only, never what Apollo answered. */
export class ApolloApiError extends Error {
  constructor(
    /** 0 when Apollo could not be reached or its answer was not what its documentation describes. */
    readonly status: number,
    readonly retryAfterMs?: number
  ) {
    super(`Apollo request failed (${status})`);
    this.name = "ApolloApiError";
  }
}

const API = "https://api.apollo.io/api/v1";
const REQUEST_TIMEOUT_MS = 30_000;
/** Apollo's own advice when it limits requests without saying for how long. */
const DEFAULT_RETRY_AFTER_MS = 60_000;

/** One read, with the key in the header Apollo documents. It is never put in the address or in an error. */
async function apolloRead(path: string, apiKey: string, body?: Record<string, unknown>): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method: body ? "POST" : "GET",
      headers: { accept: "application/json", "content-type": "application/json", "cache-control": "no-cache", "x-api-key": apiKey },
      body: body ? JSON.stringify(body) : undefined,
      // The key must not follow a redirect to somewhere else.
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ApolloApiError(0);
  }
  if (res.status === 429) {
    const seconds = Number(res.headers.get("retry-after"));
    throw new ApolloApiError(429, seconds > 0 ? seconds * 1000 : DEFAULT_RETRY_AFTER_MS);
  }
  if (!res.ok) throw new ApolloApiError(res.status);
  try {
    return await res.json();
  } catch {
    throw new ApolloApiError(0);
  }
}

type Json = Record<string, unknown>;
const object = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {});
/** A value as text, or nothing when it is absent or blank. */
const text = (value: unknown): string | undefined => {
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") return undefined;
  // Postgres text cannot hold a NUL character.
  return value.replaceAll("\u0000", "").trim() || undefined;
};
/** The named array of a response. Its absence is an unexpected answer, not an empty result. */
function listed(response: unknown, key: string): Json[] {
  const found = Array.isArray(response) ? response : object(response)[key];
  if (!Array.isArray(found)) throw new ApolloApiError(0);
  return found.map(object);
}

/** Apollo's contact lists ("labels"). Lists of accounts and of sequences are left out. */
export async function readApolloLists(apiKey: string): Promise<Array<{ id: string; name: string; count: number | null }>> {
  return listed(await apolloRead("/labels", apiKey), "labels").flatMap((label) => {
    const id = text(label.id) ?? text(label._id);
    const name = text(label.name);
    if (!id || !name || (label.modality !== undefined && label.modality !== "contacts")) return [];
    const count = label.cached_count ?? label.count;
    return [{ id, name, count: typeof count === "number" ? count : null }];
  });
}

export async function readApolloContactStages(apiKey: string): Promise<Array<{ id: string; name: string }>> {
  return listed(await apolloRead("/contact_stages", apiKey), "contact_stages").flatMap((stage) => {
    const id = text(stage.id);
    const name = text(stage.display_name) ?? text(stage.name);
    return id && name ? [{ id, name }] : [];
  });
}

export interface ApolloContactQuery {
  page: number;
  perPage: number;
  listId?: string;
  keywords?: string;
  stageIds?: string[];
}

/**
 * One page of the contacts saved in the Apollo account, oldest first, so contacts saved while pages are being read
 * arrive at the end instead of shifting what has not been read yet.
 */
export async function searchApolloContacts(apiKey: string, query: ApolloContactQuery): Promise<{ contacts: ApolloContactRecord[]; total: number | null; totalPages: number | null }> {
  const response = await apolloRead("/contacts/search", apiKey, {
    page: query.page,
    per_page: query.perPage,
    sort_by_field: "contact_created_at",
    sort_ascending: true,
    ...(query.listId ? { contact_label_ids: [query.listId] } : {}),
    ...(query.keywords ? { q_keywords: query.keywords } : {}),
    ...(query.stageIds?.length ? { contact_stage_ids: query.stageIds } : {}),
  });
  const contacts = listed(object(response).contacts, "contacts").map(mapContact);
  const pagination = object(object(response).pagination);
  const number = (value: unknown) => (typeof value === "number" && value >= 0 ? value : null);
  return { contacts, total: number(pagination.total_entries), totalPages: number(pagination.total_pages) };
}

function mapContact(contact: Json): ApolloContactRecord {
  const id = text(contact.id);
  if (!id) throw new ApolloApiError(0);
  const organization = object(contact.organization);
  const account = object(contact.account);
  const phone = object(Array.isArray(contact.phone_numbers) ? contact.phone_numbers[0] : null);
  const email = text(contact.email);
  const website = text(organization.website_url) ?? text(account.website_url);
  return {
    id,
    personId: text(contact.person_id),
    firstName: text(contact.first_name),
    lastName: text(contact.last_name),
    fullName: text(contact.name),
    // Apollo can answer with a placeholder in place of an address the account has not unlocked.
    email: email && !email.toLowerCase().startsWith("email_not_unlocked@") ? email : undefined,
    emailStatus: text(contact.email_status),
    title: text(contact.title),
    headline: text(contact.headline),
    phone: text(contact.sanitized_phone) ?? text(phone.sanitized_number) ?? text(phone.raw_number),
    linkedinUrl: text(contact.linkedin_url),
    companyName: text(contact.organization_name) ?? text(organization.name) ?? text(account.name),
    companyDomain: text(organization.primary_domain) ?? text(account.primary_domain) ?? text(account.domain) ?? extractDomain(website),
    companyWebsite: website,
    city: text(contact.city),
    state: text(contact.state),
    country: text(contact.country),
    address: text(contact.present_raw_address),
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

/** The routes outside Workbooks answer with these. */
async function asHttpError<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof ApolloApiError)) throw error;
    if (error.status === 401 || error.status === 403) throw new HttpError("apollo_unauthorized", 401, { detail: "Apollo rejected the API key" });
    throw new HttpError("apollo_request_failed", 502, { status: error.status });
  }
}

/** R22.1 — the workspace's Apollo contact lists. */
export async function listApolloLists(apiKey: string): Promise<ApolloListSummary[]> {
  const lists = await asHttpError(() => readApolloLists(apiKey));
  return lists.map((l) => ({ id: l.id, name: l.name, contactCount: l.count ?? 0 }));
}

/** Contacts in one Apollo list, or the workspace's whole contact book when `listId` is omitted. */
export async function listApolloContacts(apiKey: string, listId: string | undefined, maxContacts = 500): Promise<ApolloContactRecord[]> {
  const contacts: ApolloContactRecord[] = [];
  const perPage = 100;
  for (let page = 1; contacts.length < maxContacts; page += 1) {
    const found = await asHttpError(() => searchApolloContacts(apiKey, { page, perPage, listId }));
    contacts.push(...found.contacts);
    if (found.contacts.length < perPage) break;
  }
  return contacts.slice(0, maxContacts);
}
