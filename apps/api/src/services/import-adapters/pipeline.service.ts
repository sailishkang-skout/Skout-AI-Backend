import type { Db } from "@skout/db";
import type { Env } from "../../config/env.js";
import { HttpError } from "../../utils/http.js";
import { buildEnrichmentService } from "../enrichment/index.js";
import { createApolloImportAdapter } from "./apollo.adapter.js";
import { createHubSpotImportAdapter } from "./hubspot.adapter.js";
import type { ImportAdapter, ImportListSummary } from "./types.js";

export const IMPORT_PROVIDERS = ["hubspot", "apollo"] as const;
export type ImportProvider = (typeof IMPORT_PROVIDERS)[number];

const MAX_CONTACTS = 500;

/**
 * R22.2 — provider-keyed adapter registry. Adding a third provider (Outreach.io, Salesloft,
 * Snov.io) means writing one new file implementing `ImportAdapter` and adding one line here —
 * nothing below this function changes.
 */
function resolveAdapter(db: Db, config: Env, provider: string): ImportAdapter {
  switch (provider) {
    case "hubspot":
      return createHubSpotImportAdapter(db, config);
    case "apollo":
      return createApolloImportAdapter(db, config);
    default:
      throw new HttpError("unknown_import_provider", 400, { provider, supported: IMPORT_PROVIDERS });
  }
}

export async function listProviderLists(db: Db, config: Env, provider: string, workspaceId: string): Promise<ImportListSummary[]> {
  return resolveAdapter(db, config, provider).listLists(workspaceId);
}

export async function listProviderContacts(
  db: Db,
  config: Env,
  provider: string,
  workspaceId: string,
  listId: string | undefined,
  maxContacts = MAX_CONTACTS
) {
  const adapter = resolveAdapter(db, config, provider);
  const raw = await adapter.listContacts(workspaceId, listId, Math.min(maxContacts, MAX_CONTACTS));
  return raw.map((r) => adapter.mapToProspectCandidate(r)).filter((s): s is NonNullable<typeof s> => s != null);
}

export interface CommitImportResult {
  provider: string;
  listId: string;
  listName: string;
  imported: number;
  skipped: number;
}

/**
 * Commit a provider import into a Skout list — activates each mapped contact through the same
 * `createList`/`addListMembers` primitive every other activation path in Skout already uses
 * (enrichment, LinkedIn capture, HubSpot's own import today). Never auto-activates into a
 * sequence — always lands as a reviewable list, per the R22 moat note (no silent auto-send).
 */
export async function commitProviderImport(
  db: Db,
  config: Env,
  provider: string,
  workspaceId: string,
  input: { listId?: string; newListName?: string; sourceListId?: string; maxContacts?: number }
): Promise<CommitImportResult> {
  const adapter = resolveAdapter(db, config, provider);
  const raw = await adapter.listContacts(workspaceId, input.sourceListId, Math.min(input.maxContacts ?? MAX_CONTACTS, MAX_CONTACTS));
  const snapshots = raw.map((r) => adapter.mapToProspectCandidate(r)).filter((s): s is NonNullable<typeof s> => s != null);
  const skipped = raw.length - snapshots.length;

  if (!snapshots.length) throw new HttpError(`${provider}_import_empty`, 400, { fetched: raw.length, skipped });

  const enrich = buildEnrichmentService(db, config);
  let listId = input.listId;
  let listName: string | undefined;

  if (input.newListName?.trim()) {
    const created = await enrich.createList(workspaceId, input.newListName.trim(), snapshots);
    listId = created.id;
    listName = created.name;
  } else if (listId) {
    const updated = await enrich.addListMembers(workspaceId, listId, snapshots);
    if (!updated) throw new HttpError("list_not_found", 404);
    listName = updated.name;
  } else {
    throw new HttpError("import_target_required", 400);
  }

  return { provider, listId: listId!, listName: listName!, imported: snapshots.length, skipped };
}
