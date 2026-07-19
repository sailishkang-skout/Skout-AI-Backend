import { readCsvExport, storeCsvExport } from "@skout/storage";
import type { Db } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { createAnalyticsService } from "./analytics.service.js";
import { createWorkspaceService } from "./workspace.service.js";
import { buildEnrichmentService } from "./enrichment/index.js";
import { buildSequenceService } from "./sequence.service.js";
import { buildInboxService } from "./inbox.service.js";
import { buildAiDraftService } from "./ai-draft.service.js";

const log = createLogger("ai-export");

/** Datasets the assistant can export to CSV. All are read-only and workspace-scoped. */
export const EXPORT_DATASETS = [
  "credit_transactions",
  "credit_by_action",
  "credit_daily",
  "list_members",
  "sequences",
  "ai_drafts",
  "inbox_threads",
] as const;

export type ExportDataset = (typeof EXPORT_DATASETS)[number];

export interface ExportArtifact {
  dataset: string;
  filename: string;
  rowCount: number;
  downloadUrl: string;
  exportKey: string;
  inline: boolean;
}

const MAX_EXPORT_ROWS = 5000;

/**
 * In-memory fallback so downloads work in local dev when EXPORTS_BUCKET is unset (storeCsvExport
 * returns content inline instead of persisting). Bounded so it can't grow without limit.
 */
const DEV_CACHE_LIMIT = 50;
const devCache = new Map<string, string>();

function cacheDevExport(key: string, content: string): void {
  devCache.set(key, content);
  while (devCache.size > DEV_CACHE_LIMIT) {
    const oldest = devCache.keys().next().value;
    if (oldest === undefined) break;
    devCache.delete(oldest);
  }
}

function csvCell(value: unknown): string {
  if (value == null) return '""';
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

/** Builds a CSV from a list of flat records, unioning keys for the header row. */
function objectsToCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headerSet = new Set<string>();
  for (const row of rows) for (const k of Object.keys(row)) headerSet.add(k);
  const headers = [...headerSet];
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(headers.map((h) => csvCell(row[h])).join(","));
  return lines.join("\n");
}

function slug(name: string): string {
  return name.replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-|-$/g, "") || "export";
}

export interface BuildDatasetOptions {
  listId?: string;
  days?: number;
}

export interface BuiltDataset {
  filename: string;
  content: string;
  rowCount: number;
}

/**
 * Produces the CSV content for a dataset. Returns `null` when there is nothing to export (empty
 * dataset) and throws for invalid input (bad dataset name / missing required option).
 */
export async function buildDatasetCsv(
  db: Db | null,
  config: Env,
  workspaceId: string,
  dataset: ExportDataset,
  options: BuildDatasetOptions = {}
): Promise<BuiltDataset | null> {
  let rows: Record<string, unknown>[] = [];
  let name = dataset as string;

  switch (dataset) {
    case "credit_transactions": {
      if (!db) throw new Error("database_unavailable");
      const ws = createWorkspaceService(db);
      const res = await ws.getCreditTransactions(workspaceId, MAX_EXPORT_ROWS, 0);
      rows = res.data.map((t) => ({
        date: t.createdAt,
        action: t.action,
        amount: t.amount,
        referenceId: t.referenceId ?? "",
        id: t.id,
      }));
      break;
    }
    case "credit_by_action": {
      const analytics = createAnalyticsService(db, config);
      const report = await analytics.getReport(workspaceId, options.days ?? 90);
      rows = report.credits.byAction.map((r) => ({ action: r.action, credits: r.credits }));
      name = "credit-usage-by-action";
      break;
    }
    case "credit_daily": {
      const analytics = createAnalyticsService(db, config);
      const report = await analytics.getReport(workspaceId, options.days ?? 90);
      rows = report.credits.daily.map((r) => ({ date: r.date, spent: r.spent, added: r.added }));
      name = "credit-usage-daily";
      break;
    }
    case "list_members": {
      if (!options.listId) throw new Error("listId is required for list_members export");
      const enrichment = buildEnrichmentService(db, config);
      const detail = await enrichment.getListDetail(workspaceId, options.listId);
      if (!detail) throw new Error("list_not_found");
      name = slug(detail.list.name);
      rows = (detail.members ?? []).slice(0, MAX_EXPORT_ROWS).map((m) => {
        const snap = (m.snapshot ?? {}) as Record<string, unknown>;
        return {
          fullName: snap.fullName ?? snap.companyName ?? m.prospectId,
          title: snap.title ?? "",
          companyName: snap.companyName ?? "",
          companyDomain: snap.companyDomain ?? "",
          industry: snap.industry ?? "",
          country: snap.country ?? "",
          email: snap.email ?? "",
          emailStatus: snap.emailStatus ?? "",
          icpScore: m.score?.score ?? "",
        };
      });
      break;
    }
    case "sequences": {
      const svc = buildSequenceService(db);
      if (!svc) throw new Error("database_unavailable");
      const seqs = await svc.listSequences(workspaceId);
      rows = seqs.map((s) => ({ ...(s as unknown as Record<string, unknown>) }));
      break;
    }
    case "ai_drafts": {
      if (!db) throw new Error("database_unavailable");
      const drafts = buildAiDraftService(db);
      const res = await drafts.list(workspaceId, { limit: MAX_EXPORT_ROWS });
      rows = res.data.map((d) => {
        const row = d as unknown as Record<string, unknown>;
        return {
          id: row.id,
          status: row.status,
          prospectName: row.prospectName ?? "",
          companyName: row.companyName ?? "",
          subject: row.subject ?? "",
          icpScore: row.icpScore ?? "",
          createdAt: row.createdAt,
        };
      });
      break;
    }
    case "inbox_threads": {
      const inbox = buildInboxService(db, config);
      if (!inbox) throw new Error("database_unavailable");
      const res = await inbox.listThreads(workspaceId, { limit: 500, offset: 0 });
      rows = (res.data as unknown as Record<string, unknown>[]).map((t) => ({
        id: t.id,
        status: t.status,
        subject: t.subject ?? "",
        prospectName: t.prospectName ?? t.prospectEmail ?? "",
        lastMessageAt: t.lastMessageAt ?? t.updatedAt ?? "",
      }));
      break;
    }
    default:
      throw new Error(`unknown_dataset:${String(dataset)}`);
  }

  if (rows.length === 0) return null;
  return {
    filename: `${slug(name)}.csv`,
    content: objectsToCsv(rows),
    rowCount: rows.length,
  };
}

function downloadUrl(config: Env, key: string): string {
  const base = (config.API_PUBLIC_URL ?? "").replace(/\/$/, "");
  return `${base}/api/v1/ai/exports/download?key=${encodeURIComponent(key)}`;
}

/** Stores a generated CSV (S3 if configured, in-memory dev cache otherwise) and returns a link. */
export async function storeAiExport(
  config: Env,
  workspaceId: string,
  dataset: string,
  built: BuiltDataset
): Promise<ExportArtifact> {
  // listId slot in the key is used to namespace AI exports under exports/{workspaceId}/ai/…
  const stored = await storeCsvExport(
    config.EXPORTS_BUCKET,
    workspaceId,
    "ai",
    built.filename,
    built.content
  );
  if (stored.inline && stored.content != null) cacheDevExport(stored.key, stored.content);
  return {
    dataset,
    filename: built.filename,
    rowCount: built.rowCount,
    exportKey: stored.key,
    downloadUrl: downloadUrl(config, stored.key),
    inline: stored.inline,
  };
}

/** Reads back a stored AI export for the download route. Throws if missing. */
export async function readAiExport(config: Env, key: string): Promise<string> {
  if (config.EXPORTS_BUCKET) return readCsvExport(config.EXPORTS_BUCKET, key);
  const cached = devCache.get(key);
  if (cached == null) {
    log.warn("dev export not found in cache", { key });
    throw new Error("export_not_found");
  }
  return cached;
}
