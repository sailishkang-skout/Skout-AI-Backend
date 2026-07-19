import type { OpenAI } from "openai";
import type { Db } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { createAnalyticsService } from "./analytics.service.js";
import { createDashboardService } from "./dashboard.service.js";
import { createWorkspaceService } from "./workspace.service.js";
import { buildEnrichmentService } from "./enrichment/index.js";
import { buildSequenceService } from "./sequence.service.js";
import { buildInboxService, getDeliverabilityMetrics } from "./inbox.service.js";
import { buildAiDraftService } from "./ai-draft.service.js";
import { createBillingService } from "./billing.service.js";
import { createIntegrationService } from "./integration.service.js";
import { createTeamService } from "./team.service.js";
import { getWorkspaceIcp } from "./icp.service.js";
import {
  EXPORT_DATASETS,
  buildDatasetCsv,
  storeAiExport,
  type ExportArtifact,
  type ExportDataset,
} from "./ai-export.service.js";

const log = createLogger("ai-workspace-tools");

type ToolDef = OpenAI.Chat.Completions.ChatCompletionTool;

/** Read-only workspace tools the in-app assistant may call to fetch live data on demand. */
export interface WorkspaceToolRunner {
  tools: ToolDef[];
  /** Execute a tool by name; always resolves to a JSON string (errors are returned, not thrown). */
  run(name: string, args: Record<string, unknown>): Promise<string>;
  /** Exports generated during this chat turn (surfaced to the client by the route). */
  getCreatedExports(): ExportArtifact[];
}

/** Caps to keep tool payloads (and therefore token cost) bounded. */
const MAX_ROWS = 50;
const MAX_RESULT_CHARS = 12_000;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

function serialize(value: unknown): string {
  let out: string;
  try {
    out = JSON.stringify(value ?? null);
  } catch {
    out = JSON.stringify({ error: "result_not_serializable" });
  }
  if (out.length > MAX_RESULT_CHARS) {
    out = out.slice(0, MAX_RESULT_CHARS) + `…"[truncated ${out.length - MAX_RESULT_CHARS} chars]`;
  }
  return out;
}

/**
 * The catalog of read-only tools. Keeping this as a plain list keeps the JSON schema (sent to the
 * model) and the executor switch in one place, so adding a tool is a single edit.
 */
export const WORKSPACE_TOOL_DEFS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "get_workspace_overview",
      description:
        "High-level snapshot of the current workspace: name, credit balance, list/prospect counts, ICP status, and this-week activity (searches, enrich/score jobs, exports).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_credit_analytics",
      description:
        "Credit usage analytics over a period: current balance, credits spent/added/net, spend broken down BY ACTION (search, enrichment, ai_score, exports, top-ups) — use this for credit usage charts/pie charts — plus a daily time series and enrichment job stats.",
      parameters: {
        type: "object",
        properties: {
          days: {
            type: "number",
            description: "Lookback window in days (7-90). Use 7 for 'this week'. Default 30.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_credit_transactions",
      description:
        "Paginated raw credit ledger (individual debits/credits with action + timestamp) for the workspace, newest first.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max rows (1-50). Default 25." },
          offset: { type: "number", description: "Rows to skip for pagination. Default 0." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_lists",
      description: "All prospect lists in the workspace with their prospect counts.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_list_detail",
      description:
        "Members of a specific prospect list (name/title/company snapshots + ICP scores). Members are capped; use for inspecting who is in a list.",
      parameters: {
        type: "object",
        properties: { listId: { type: "string", description: "The list id." } },
        required: ["listId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_icp",
      description:
        "The workspace's Ideal Customer Profile config (industries, countries, seniorities, titles, keywords, employee range).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_sequences",
      description: "All outbound sequences (cadences) in the workspace with their status.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_sequence",
      description: "A single sequence with its ordered steps.",
      parameters: {
        type: "object",
        properties: { sequenceId: { type: "string", description: "The sequence id." } },
        required: ["sequenceId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_sequence_analytics",
      description:
        "Per-step funnel and enrollment summary for a sequence (sent, opened, replied, bounced, etc.).",
      parameters: {
        type: "object",
        properties: { sequenceId: { type: "string", description: "The sequence id." } },
        required: ["sequenceId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_inboxes",
      description:
        "Sending inboxes with health/warmup status and today's send counts (secrets excluded).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_inbox_unread_counts",
      description: "Count of inbox threads by status (new/replied/bounced/meeting_booked/closed).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_threads",
      description:
        "Inbox conversation threads with prospect hints. Filter by status and paginate.",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["new", "replied", "bounced", "meeting_booked", "closed"],
            description: "Optional status filter.",
          },
          limit: { type: "number", description: "Max threads (1-50). Default 25." },
          offset: { type: "number", description: "Rows to skip. Default 0." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_thread",
      description:
        "Full context + messages for one inbox thread (prospect, sequence, and message history).",
      parameters: {
        type: "object",
        properties: { threadId: { type: "string", description: "The thread id (uuid)." } },
        required: ["threadId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_deliverability",
      description:
        "30-day deliverability metrics: warmup progress, bounce/spam rates, and summary health.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_ai_drafts",
      description:
        "AI-generated email drafts and their review status (pending_review/edited/approved/rejected/sent).",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["pending_review", "edited", "approved", "rejected", "sent"],
            description: "Optional status filter.",
          },
          limit: { type: "number", description: "Max drafts (1-50). Default 25." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_integrations",
      description: "Connected integrations (CRM, etc.) and their connection status (no secrets).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_team_members",
      description: "Workspace team members with their roles.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_invoices",
      description: "Paid credit-pack invoices for the workspace, grouped by month.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "export_dataset",
      description:
        "Generate a downloadable CSV export of a workspace dataset (opens in Excel). The file is created server-side and a download link is returned to the user automatically — you do NOT need to include the CSV contents in your reply, just tell the user their export is ready. Use this when the user asks to export, download, Excel, or spreadsheet.",
      parameters: {
        type: "object",
        properties: {
          dataset: {
            type: "string",
            enum: [...EXPORT_DATASETS],
            description:
              "Which dataset to export: credit_transactions (full ledger), credit_by_action, credit_daily, list_members (needs listId), sequences, ai_drafts, inbox_threads.",
          },
          listId: {
            type: "string",
            description: "Required only when dataset is 'list_members'.",
          },
          days: {
            type: "number",
            description: "Optional lookback window (7-90) for credit_by_action / credit_daily.",
          },
        },
        required: ["dataset"],
      },
    },
  },
];

/**
 * Builds a runner bound to one workspace. All handlers are READ-ONLY — nothing here mutates data
 * or spends credits. The db may be null (returns a friendly error per call).
 */
export function createWorkspaceToolRunner(
  db: Db | null,
  config: Env,
  workspaceId: string
): WorkspaceToolRunner {
  const analytics = createAnalyticsService(db, config);
  const dashboard = createDashboardService(db, config);
  const enrichment = buildEnrichmentService(db, config);
  const sequence = buildSequenceService(db);
  const inbox = buildInboxService(db, config);
  const integrations = createIntegrationService(db, config);
  const workspace = db ? createWorkspaceService(db) : null;
  const drafts = db ? buildAiDraftService(db) : null;
  const billing = db ? createBillingService(db, config) : null;
  const team = db ? createTeamService(db) : null;

  const createdExports: ExportArtifact[] = [];

  const handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
    get_workspace_overview: () => dashboard.getSummary(workspaceId),

    get_credit_analytics: async (args) => {
      const days = clampInt(args.days, 30, 7, 90);
      const report = await analytics.getReport(workspaceId, days);
      return {
        period: report.period,
        credits: report.credits,
        enrichment: report.enrichment,
        lists: report.lists,
      };
    },

    get_credit_transactions: (args) => {
      if (!workspace) throw new Error("database_unavailable");
      const limit = clampInt(args.limit, 25, 1, MAX_ROWS);
      const offset = clampInt(args.offset, 0, 0, 100_000);
      return workspace.getCreditTransactions(workspaceId, limit, offset);
    },

    list_lists: () => enrichment.listLists(workspaceId),

    get_list_detail: async (args) => {
      const listId = String(args.listId ?? "");
      if (!listId) throw new Error("listId is required");
      const detail = await enrichment.getListDetail(workspaceId, listId);
      if (!detail) return null;
      const members = Array.isArray(detail.members) ? detail.members : [];
      return {
        list: detail.list,
        memberCount: members.length,
        members: members.slice(0, MAX_ROWS),
      };
    },

    get_icp: () => getWorkspaceIcp(db, workspaceId),

    list_sequences: () => {
      if (!sequence) throw new Error("database_unavailable");
      return sequence.listSequences(workspaceId);
    },

    get_sequence: (args) => {
      if (!sequence) throw new Error("database_unavailable");
      const id = String(args.sequenceId ?? "");
      if (!id) throw new Error("sequenceId is required");
      return sequence.getSequenceById(workspaceId, id);
    },

    get_sequence_analytics: (args) => {
      if (!sequence) throw new Error("database_unavailable");
      const id = String(args.sequenceId ?? "");
      if (!id) throw new Error("sequenceId is required");
      return sequence.getAnalytics(workspaceId, id);
    },

    list_inboxes: () => {
      if (!inbox) throw new Error("database_unavailable");
      return inbox.listInboxes(workspaceId);
    },

    get_inbox_unread_counts: () => {
      if (!inbox) throw new Error("database_unavailable");
      return inbox.getUnreadCounts(workspaceId);
    },

    list_threads: (args) => {
      if (!inbox) throw new Error("database_unavailable");
      const limit = clampInt(args.limit, 25, 1, MAX_ROWS);
      const offset = clampInt(args.offset, 0, 0, 100_000);
      const status = typeof args.status === "string" ? args.status : undefined;
      return inbox.listThreads(workspaceId, {
        limit,
        offset,
        ...(status ? { status: status as never } : {}),
      });
    },

    get_thread: async (args) => {
      if (!inbox) throw new Error("database_unavailable");
      const threadId = String(args.threadId ?? "");
      if (!threadId) throw new Error("threadId is required");
      const [context, messages] = await Promise.all([
        inbox.getThreadContext(workspaceId, threadId),
        inbox.listMessages(workspaceId, threadId, { limit: MAX_ROWS, offset: 0 }),
      ]);
      if (!context) return null;
      return { context, messages };
    },

    get_deliverability: () => {
      if (!db) throw new Error("database_unavailable");
      return getDeliverabilityMetrics(db, workspaceId);
    },

    list_ai_drafts: (args) => {
      if (!drafts) throw new Error("database_unavailable");
      const limit = clampInt(args.limit, 25, 1, MAX_ROWS);
      const status = typeof args.status === "string" ? args.status : undefined;
      return drafts.list(workspaceId, {
        limit,
        ...(status ? { status: status as never } : {}),
      });
    },

    list_integrations: () => integrations.list(workspaceId),

    list_team_members: () => {
      if (!team) throw new Error("database_unavailable");
      return team.listMembers(workspaceId);
    },

    list_invoices: () => {
      if (!billing) throw new Error("database_unavailable");
      return billing.listInvoices(workspaceId);
    },

    export_dataset: async (args) => {
      const dataset = String(args.dataset ?? "") as ExportDataset;
      if (!EXPORT_DATASETS.includes(dataset)) {
        throw new Error(`unknown_dataset:${dataset}`);
      }
      const built = await buildDatasetCsv(db, config, workspaceId, dataset, {
        listId: typeof args.listId === "string" ? args.listId : undefined,
        days: typeof args.days === "number" ? args.days : undefined,
      });
      if (!built) return { empty: true, message: "No rows to export for this dataset." };
      const artifact = await storeAiExport(config, workspaceId, dataset, built);
      createdExports.push(artifact);
      // Return only metadata to the model — the download link is surfaced by the route.
      return {
        dataset: artifact.dataset,
        filename: artifact.filename,
        rowCount: artifact.rowCount,
        downloadUrl: artifact.downloadUrl,
        path: artifact.path,
        ready: true,
      };
    },
  };

  return {
    tools: WORKSPACE_TOOL_DEFS,
    getCreatedExports: () => createdExports,
    async run(name, args) {
      const handler = handlers[name];
      if (!handler) return serialize({ error: `unknown_tool:${name}` });
      try {
        const result = await handler(args ?? {});
        return serialize(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("workspace tool failed", { tool: name, workspaceId, err: message });
        return serialize({ error: message });
      }
    },
  };
}
