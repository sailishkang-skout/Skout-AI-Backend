import type { Env } from "../config/env.js";
import { createLogger } from "@skout/observability";
import { buildListCsv } from "../utils/list-csv.js";
import { storeListCsvExport } from "./export-storage.service.js";
import type { EnrichmentService } from "./enrichment/service.js";
import type { ListService } from "./list.service.js";
import { InsufficientCreditsError } from "./enrichment/types.js";

const log = createLogger("list-export.service");

export const CSV_EXPORT_CREDIT_COST = 2;

export interface ListCsvExportResult {
  downloadUrl: string;
  filename: string;
  creditsUsed: number;
  memberCount: number;
  exportKey?: string;
  inline?: boolean;
  content?: string;
}

export async function exportListCsv(
  config: Env,
  listSvc: ListService,
  enrichment: EnrichmentService,
  workspaceId: string,
  listId: string
): Promise<ListCsvExportResult> {
  const list = await listSvc.getListById(workspaceId, listId);
  if (!list) throw new Error("list_not_found");

  const balance = await enrichment.getCredits(workspaceId);
  if (balance < CSV_EXPORT_CREDIT_COST) {
    throw new InsufficientCreditsError(CSV_EXPORT_CREDIT_COST, balance);
  }

  const members = await listSvc.getMembers(workspaceId, listId);
  const scores = members?.length
    ? await enrichment.lookupScores(
        workspaceId,
        members.map((m) => m.prospectId)
      )
    : {};

  const { filename, content } = buildListCsv(
    list.name,
    (members ?? []).map((m) => ({
      prospectId: m.prospectId,
      snapshot: m.snapshot,
      score: scores[m.prospectId] ?? null,
    }))
  );

  await enrichment.deductExportCredits(workspaceId, CSV_EXPORT_CREDIT_COST, listId);

  const stored = await storeListCsvExport(config, workspaceId, listId, filename, content);
  const base = config.API_PUBLIC_URL ?? "http://localhost:3001";
  const memberCount = members?.length ?? 0;

  log.info("list csv export completed", {
    workspaceId,
    listId,
    memberCount,
    creditsUsed: CSV_EXPORT_CREDIT_COST,
    inline: Boolean(stored.inline),
  });

  if (stored.inline) {
    return {
      downloadUrl: `${base}/api/v1/lists/${listId}/export/csv/download?key=${encodeURIComponent(stored.key)}`,
      filename: stored.filename,
      creditsUsed: CSV_EXPORT_CREDIT_COST,
      memberCount,
      exportKey: stored.key,
      inline: true,
      content: stored.content ?? content,
    };
  }

  return {
    downloadUrl: `${base}/api/v1/lists/${listId}/export/csv/download?key=${encodeURIComponent(stored.key)}`,
    filename: stored.filename,
    creditsUsed: CSV_EXPORT_CREDIT_COST,
    memberCount,
    exportKey: stored.key,
  };
}
