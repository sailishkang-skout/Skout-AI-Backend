import type { Db } from "@skout/db";
import type { Env } from "../../config/env.js";
import { HttpError } from "../../utils/http.js";
import type { ApolloContactRecord } from "../apollo-contacts.client.js";
import { listApolloContacts, listApolloLists } from "../apollo-contacts.client.js";
import { createIntegrationService } from "../integration.service.js";
import type { ImportAdapter, ImportListSummary, RawContact } from "./types.js";

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
