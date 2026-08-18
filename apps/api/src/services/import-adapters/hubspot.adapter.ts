import type { Db } from "@skout/db";
import type { Env } from "../../config/env.js";
import { hubSpotContactToSnapshot } from "../crm.service.js";
import { ensureFreshTokens } from "../crm-export.runner.js";
import { createHubSpotCredentialsStore, type HubSpotCredentialsStore } from "../hubspot-credentials.store.js";
import { fetchAllHubSpotContacts, fetchHubSpotListContacts, searchHubSpotLists } from "../hubspot.client.js";
import type { ImportAdapter, ImportListSummary, RawContact } from "./types.js";

/** R22.2 — wraps the existing `hubspot.client.ts` calls (unchanged) behind the shared adapter interface. */
export function createHubSpotImportAdapter(db: Db, config: Env): ImportAdapter {
  const credentialsStore: HubSpotCredentialsStore = createHubSpotCredentialsStore(config);

  return {
    provider: "hubspot",

    async listLists(workspaceId: string): Promise<ImportListSummary[]> {
      const tokens = await ensureFreshTokens(db, config, credentialsStore, workspaceId);
      const lists = await searchHubSpotLists(tokens.accessToken);
      return lists.map((l) => ({ id: l.listId, name: l.name, count: l.size }));
    },

    async listContacts(workspaceId: string, listId: string | undefined, maxContacts: number): Promise<RawContact[]> {
      const tokens = await ensureFreshTokens(db, config, credentialsStore, workspaceId);
      const contacts = listId
        ? await fetchHubSpotListContacts(tokens.accessToken, listId, maxContacts)
        : await fetchAllHubSpotContacts(tokens.accessToken, maxContacts);
      return contacts as unknown as RawContact[];
    },

    mapToProspectCandidate(raw: RawContact) {
      return hubSpotContactToSnapshot(raw as { id: string; properties: Parameters<typeof hubSpotContactToSnapshot>[0]["properties"] });
    },
  };
}
