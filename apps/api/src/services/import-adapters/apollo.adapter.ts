import type { Db } from "@skout/db";
import type { Env } from "../../config/env.js";
import { HttpError } from "../../utils/http.js";
import { ApolloApiError, listApolloContacts, listApolloLists, readApolloContactStages, readApolloLists, searchApolloContacts, type ApolloContactRecord } from "../apollo-contacts.client.js";
import { CrmSourceError, type CrmField, type CrmRecordSource } from "../crm-record-source.js";
import { createIntegrationService } from "../integration.service.js";
import type { ImportAdapter, ImportListSummary, RawContact } from "./types.js";

/** Apollo lets a search be read to 500 pages of 100. */
export const APOLLO_MAX_RECORDS = 50_000;

const field = (name: string, label: string, holds?: CrmField["holds"]): CrmField => ({ name, label, type: "string", ...(holds ? { holds } : {}) });

/** What a saved contact can be imported as. */
const APOLLO_FIELDS: Array<CrmField & { read: (c: ApolloContactRecord) => string | undefined }> = [
  { ...field("name", "Full name"), read: (c) => c.fullName ?? ([c.firstName, c.lastName].filter(Boolean).join(" ") || undefined) },
  { ...field("first_name", "First name"), read: (c) => c.firstName },
  { ...field("last_name", "Last name"), read: (c) => c.lastName },
  { ...field("email", "Email", "email"), read: (c) => c.email },
  { ...field("email_status", "Email status"), read: (c) => c.emailStatus },
  { ...field("title", "Title"), read: (c) => c.title },
  { ...field("headline", "Headline"), read: (c) => c.headline },
  { ...field("company", "Company"), read: (c) => c.companyName },
  { ...field("company_domain", "Company domain", "domain"), read: (c) => c.companyDomain },
  { ...field("company_website", "Company website", "url"), read: (c) => c.companyWebsite },
  { ...field("linkedin_url", "LinkedIn URL", "linkedin_url"), read: (c) => c.linkedinUrl },
  { name: "phone", label: "Phone", type: "phone", read: (c) => c.phone },
  { ...field("location", "Location"), read: (c) => [c.city, c.state, c.country].filter(Boolean).join(", ") || c.address },
  { ...field("city", "City"), read: (c) => c.city },
  { ...field("state", "State"), read: (c) => c.state },
  { ...field("country", "Country"), read: (c) => c.country },
];

/** What Apollo answered, in the terms an import understands. */
async function reading<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof ApolloApiError)) throw error;
    const { status } = error;
    if (status === 401) throw new CrmSourceError("reauth");
    if (status === 403) throw new CrmSourceError("scope");
    if (status === 429) throw new CrmSourceError("rate_limited", error.retryAfterMs);
    if (status === 400 || status === 422) throw new CrmSourceError("rejected");
    throw new CrmSourceError("unavailable");
  }
}

/**
 * WB2-024 — the workspace's saved Apollo contacts, read a page at a time for a workbook import: one saved list, or a
 * search of them by keywords and contact stages. Apollo's search of its whole people database is not offered: it returns
 * no email addresses, LinkedIn URLs or domains, and getting them spends Apollo credits.
 */
export const apolloContactSource: CrmRecordSource = {
  objects: ["contact"],
  views: { label: "list", note: "Apollo's saved searches aren't available through its API." },
  maxFilters: 0,
  globalIds: true,
  maxRecords: APOLLO_MAX_RECORDS,
  verifyViews: true,
  maxRateLimitWaitMs: 60_000,
  operatorsFor: () => [],
  defaultFields: () => ["name", "email", "title", "company", "company_domain", "linkedin_url", "location"],
  listFields: async () => APOLLO_FIELDS.map(({ read: _read, ...known }) => known),
  listViews: (key) => reading(() => readApolloLists(key)),
  listStages: (key) => reading(() => readApolloContactStages(key)),
  count: async (key, query) => (await reading(() => searchApolloContacts(key, { page: 1, perPage: 1, listId: query.viewId, ...query.search }))).total,
  async page(key, query, cursor, limit) {
    const number = cursor === null ? 1 : Number(cursor);
    const found = await reading(() => searchApolloContacts(key, { page: number, perPage: limit, listId: query.viewId, ...query.search }));
    const more = found.contacts.length > 0 && (found.totalPages === null ? found.contacts.length === limit : number < found.totalPages);
    const reachable = number * limit < APOLLO_MAX_RECORDS;
    const wanted = APOLLO_FIELDS.filter((f) => query.fields.includes(f.name));
    return {
      records: found.contacts.map((contact) => ({
        id: contact.id,
        properties: Object.fromEntries(wanted.map((f) => [f.name, f.read(contact) ?? null])),
        ...(contact.personId ? { ref: { personId: contact.personId } } : {}),
      })),
      next: more && reachable ? String(number + 1) : null,
      total: found.total,
      ...(!reachable && (found.total ?? 0) > APOLLO_MAX_RECORDS ? { limited: true } : {}),
    };
  },
};

/** R22.1/R22.2 — Apollo contact/list import (net-new; the existing Apollo integration only
 * imported sequences, see apollo-import.service.ts / R22.3), behind the shared adapter
 * interface. Reuses the same BYOK key storage as every other workspace-connected provider. */
export function createApolloImportAdapter(db: Db, config: Env): ImportAdapter {
  async function requireApiKey(workspaceId: string): Promise<string> {
    const integrations = createIntegrationService(db, config);
    const apiKey = await integrations.getDecryptedProviderKey(workspaceId, "apollo");
    if (!apiKey) throw new HttpError("apollo_not_connected", 400, { hint: "Connect Apollo in Settings → Integrations first" });
    return apiKey;
  }

  return {
    provider: "apollo",

    async listLists(workspaceId: string): Promise<ImportListSummary[]> {
      const apiKey = await requireApiKey(workspaceId);
      const lists = await listApolloLists(apiKey);
      return lists.map((l) => ({ id: l.id, name: l.name, count: l.contactCount }));
    },

    async listContacts(workspaceId: string, listId: string | undefined, maxContacts: number): Promise<RawContact[]> {
      const apiKey = await requireApiKey(workspaceId);
      const contacts = await listApolloContacts(apiKey, listId, maxContacts);
      return contacts as unknown as RawContact[];
    },

    mapToProspectCandidate(raw: RawContact) {
      const c = raw as unknown as ApolloContactRecord;
      const fullName = [c.firstName, c.lastName].filter(Boolean).join(" ").trim() || undefined;
      if (!c.companyDomain) return null;
      if (!fullName && !c.email) return null;

      return {
        fullName,
        title: c.title,
        companyDomain: c.companyDomain,
        companyName: c.companyName,
        email: c.email,
        phone: c.phone,
        linkedinUrl: c.linkedinUrl,
        signals: ["apollo_import"],
      };
    },
  };
}
