import type { ProspectSnapshot } from "../enrichment/index.js";

export interface ImportListSummary {
  id: string;
  name: string;
  count: number;
}

/** A provider's raw contact record — shape varies per provider, mapped by mapToProspectCandidate. */
export type RawContact = Record<string, unknown>;

/**
 * R22.2 — shared shape every GTM-provider import implements. `listContacts`/`listLists` do the
 * provider-specific API call; `mapToProspectCandidate` converts one raw contact into the same
 * `ProspectSnapshot` the rest of Skout already activates from (HubSpot's own import path,
 * enrichment, LinkedIn capture, ...) — that shared snapshot shape is the actual "core pipeline"
 * a third provider (Outreach.io, Salesloft, Snov.io) plugs into without changing anything else.
 */
export interface ImportAdapter {
  readonly provider: string;
  listLists(workspaceId: string): Promise<ImportListSummary[]>;
  listContacts(workspaceId: string, listId: string | undefined, maxContacts: number): Promise<RawContact[]>;
  mapToProspectCandidate(raw: RawContact): ProspectSnapshot | null;
}
