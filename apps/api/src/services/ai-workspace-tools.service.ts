import type { OpenAI } from "openai";
import { and, count, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { recordEvidence, schema, scopedTo } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { createAnalyticsService } from "./analytics.service.js";
import { createDashboardService } from "./dashboard.service.js";
import { createWorkspaceService } from "./workspace.service.js";
import { buildEnrichmentService } from "./enrichment/index.js";
import { buildSequenceService, enrollListWithSideEffects } from "./sequence.service.js";
import { buildInboxService, getDeliverabilityMetrics } from "./inbox.service.js";
import { buildAiDraftService } from "./ai-draft.service.js";
import { createBillingService } from "./billing.service.js";
import { createIntegrationService } from "./integration.service.js";
import { createTeamService } from "./team.service.js";
import { assertEvidenced, seniorityEnum, type EvidencedClaim } from "@skout/shared";
import type { z } from "zod";
import { getWorkspaceIcp, getWorkspaceIcpVersion } from "./icp.service.js";
import { createSearchService } from "./search.service.js";
import { startWorkbookRun } from "./workbook-run.service.js";
import { getWorkbook } from "./workbook.service.js";
import { aiService } from "./ai.service.js";
import { computeSignalStackScore, listSignalsForEntity, signalStackWeightsFromEnv } from "./signal.service.js";
import { scoreIcpFitLocally, type ScoreInput } from "./intelligence-layer.service.js";
import { getCopilotPersonaDef, type CopilotPersona } from "./ai-copilot-personas.service.js";
import {
  EXPORT_DATASETS,
  buildDatasetCsv,
  storeAiExport,
  type ExportArtifact,
  type ExportDataset,
} from "./ai-export.service.js";
import { computeCroSummary } from "./cro-summary.service.js";
import { createRegionalBriefService } from "./regional-brief.service.js";
import { createCountryIndustryTamService } from "./country-industry-tam.service.js";
import { classifyAndRecord } from "./policy-gateway.service.js";
import { type ToolActionPreview } from "./intelligence-layer.service.js";

export interface ActionPreview {
  toolName: string;
  scope: string;
  assumptions: string[];
  affectedRecordCount: number;
  creditCost: number;
  externalSideEffects: string[];
}

export function requiresConfirmation(preview: ActionPreview): boolean {
  return preview.affectedRecordCount > 1 || preview.creditCost > 0 || preview.externalSideEffects.length > 0;
}

/**
 * §6.1 anti-hallucination contract — wraps a computed/derived claim (an aggregation, TAM
 * estimate, or other analytics value) with a real evidence_ledger row before it can be returned
 * to a copilot caller, rather than handing back a bare, unaudited number.
 */
export async function evidenceClaim<T>(
  db: Db,
  workspaceId: string,
  toolName: string,
  entityType: string,
  entityId: string,
  value: T
): Promise<EvidencedClaim<T>> {
  const row = await recordEvidence(db, {
    workspaceId,
    entityType,
    entityId,
    attribute: toolName,
    value: value as unknown,
    source: `ai-workspace-tools:${toolName}`,
    observedAt: new Date(),
    confidence: 100,
  });
  return assertEvidenced({ value, evidenceId: row.id }, toolName);
}

const APP_ROUTES = [
  { path: "/dashboard", purpose: "Workspace overview and recent enrichment jobs" },
  { path: "/prospects/search", purpose: "Search the prospect corpus with filters" },
  { path: "/prospects/add", purpose: "Manually add a prospect" },
  { path: "/import", purpose: "Import prospects from CSV/Excel/PDF" },
  { path: "/smart-lists", purpose: "Save filter sets and activate matches" },
  { path: "/lists", purpose: "Manage prospect lists, enrich, enroll" },
  { path: "/enrichment", purpose: "Enrichment job queue and retries" },
  { path: "/onboarding/icp", purpose: "First-run ICP wizard" },
  { path: "/settings/icp", purpose: "Edit Ideal Customer Profile" },
  { path: "/sequences", purpose: "Outbound email/LinkedIn cadences" },
  { path: "/inbox", purpose: "Unified inbox and Sent folder" },
  { path: "/deliverability", purpose: "Inboxes, domains, warmup, deliverability" },
  { path: "/ai/review", purpose: "Approve/reject AI email drafts" },
  { path: "/analytics", purpose: "Usage and performance analytics" },
  { path: "/settings/crm", purpose: "HubSpot connect / import / export" },
  { path: "/settings/integrations", purpose: "BYOK enrichment API keys" },
  { path: "/settings/team", purpose: "Invite teammates and manage roles" },
  { path: "/settings/workspace", purpose: "Workspace name, credits, billing" },
] as const;

const { listMembers, lists } = schema;

const log = createLogger("ai-workspace-tools");

type ToolDef = OpenAI.Chat.Completions.ChatCompletionTool;

/**
 * Workspace tools the in-app assistant may call. Most are read-only fetches, but a handler that
 * mutates data, spends credits, or has an external side effect (e.g. create_outbound_sequence,
 * enroll_list) MUST register a `previewBuilders` entry so its effects are gated behind an
 * explicit user confirmation before running.
 */
export interface WorkspaceToolRunner {
  tools: ToolDef[];
  /** Execute a tool by name; always resolves to a JSON string (errors are returned, not thrown). */
  run(name: string, args: Record<string, unknown>): Promise<string>;
  /** Exports generated during this chat turn (surfaced to the client by the route). */
  getCreatedExports(): ExportArtifact[];
  /** Sequences created during this chat turn. */
  getCreatedSequenceIds(): string[];
  /** §8.13 — last mutating tool preview awaiting user confirmation. */
  getPendingToolPreview(): ToolActionPreview | null;
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
 * §8.13 — server-side cache of the exact args a preview was computed from, keyed by
 * (workspaceId, toolName). A confirm call executes these cached args verbatim, never whatever the
 * model resupplies on the second call — this is a correctness property (the confirmed action must
 * be exactly what was previewed, not something the model could quietly drift on) as much as a
 * convenience: the model doesn't need to recall/resupply the full original arguments (a sequence's
 * complete multi-step copy, for example) to confirm — it only needs to call the tool again with
 * confirmed: true. In-memory and process-local by design: losing a pending preview across a
 * restart just means the user re-states their request, which is an acceptable, low-frequency cost
 * for this slice — not a data-safety issue, since nothing executes without an explicit confirm.
 */
interface PendingPreview {
  args: Record<string, unknown>;
  expiresAt: number;
}
const pendingPreviews = new Map<string, PendingPreview>();
const PENDING_PREVIEW_TTL_MS = 10 * 60 * 1000;

function pendingPreviewKey(workspaceId: string, toolName: string): string {
  return `${workspaceId}:${toolName}`;
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
        "Generate a downloadable CSV export of a workspace dataset (opens in Excel). The file is created server-side and a download button is shown in the UI automatically — you must NOT include download URLs, markdown links, or CSV contents in your reply. Just briefly confirm the export is ready.",
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
  {
    type: "function",
    function: {
      name: "search_prospects",
      description:
        "FREE preview search of the prospect corpus (does NOT spend credits). Use for 'find leads', 'who matches ICP', sample people/companies. Returns up to 10 summaries. For full search UI, navigate to /prospects/search.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Free-text query (name, title, company, keywords).",
          },
          industry: { type: "string", description: "Optional industry filter." },
          country: { type: "string", description: "Optional country code/name filter." },
          seniority: { type: "string", description: "Optional seniority filter." },
          title: { type: "string", description: "Optional job title filter." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_prospect",
      description:
        "Load one prospect/company detail by prospectId (title, company, scores, signals, etc.).",
      parameters: {
        type: "object",
        properties: { prospectId: { type: "string", description: "The prospect id." } },
        required: ["prospectId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_enrichment_jobs",
      description:
        "Recent enrichment / scoring jobs for the workspace (status, prospect, credits).",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max jobs (1-50). Default 20." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_cro_summary",
      description:
        "ADMIN ONLY — exec rollup for CRO Copilot: company/contact/open-deal counts, pipeline value, overdue tasks, stale deals (no update in 14+ days), and rep activity over the last 7 days. Only available when the agent is 'cro' and the caller is owner/admin.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_app_routes",
      description:
        "Catalog of important in-app routes and what each screen is for. Use before suggesting navigation.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_regional_selling_brief",
      description:
        "Retrieve fact-checked regional/country sales intelligence, buyer economics, local etiquette, channel policy (email vs LinkedIn), telecom regulations (calling hours), and privacy compliance (GDPR/CCPA) for a target country or region.",
      parameters: {
        type: "object",
        properties: {
          country: {
            type: "string",
            description: "Country name or ISO code (e.g. 'Germany', 'US', 'GBR', 'Japan').",
          },
          industry: {
            type: "string",
            description: "Optional industry or sector name (e.g. 'Information', 'saas', 'healthcare', 'finance').",
          },
        },
        required: ["country"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_market_tam",
      description:
        "Retrieve the Total Addressable Market (TAM) — target accounts, annual revenue TAM in USD, and total business establishment count with official data sources — for a target country and industry sector.",
      parameters: {
        type: "object",
        properties: {
          country: {
            type: "string",
            description: "Country name or ISO code (e.g. 'US', 'United States', 'GB', 'UK').",
          },
          industry: {
            type: "string",
            description: "NAICS code or industry sector (e.g. '51', 'Information', 'saas', '54', 'healthcare').",
          },
          icpFitPct: {
            type: "number",
            description: "Optional custom ICP fit % (e.g. 0.10 for 10%). Defaults to 0.10.",
          },
          acvUsd: {
            type: "number",
            description: "Optional custom Average Contract Value in USD (e.g. 25000). Defaults to 25000.",
          },
        },
        required: ["country", "industry"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_outbound_sequence",
      description:
        "Create, save, and draft a new multi-step outbound sales cadence/sequence directly in the workspace database. Use this whenever the user asks to create, build, draft, or set up an outreach sequence.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Name for the sequence (e.g. 'Healthcare SaaS India — Direct Outreach').",
          },
          steps: {
            type: "array",
            description: "List of sequence steps in chronological order.",
            items: {
              type: "object",
              properties: {
                stepType: {
                  type: "string",
                  enum: ["email", "linkedin", "whatsapp", "call", "wait", "task"],
                  description: "Step channel or action type.",
                },
                delayDays: {
                  type: "number",
                  description: "Days to wait after the previous step (0 for first step).",
                },
                subject: {
                  type: "string",
                  description: "Subject line for email steps (supports {{firstName}}, {{companyName}}).",
                },
                bodyTemplate: {
                  type: "string",
                  description:
                    "HTML email body or message text (supports {{firstName}}, {{companyName}}, {{senderName}}, {{unsubscribeUrl}}).",
                },
                linkedinAction: {
                  type: "string",
                  enum: ["connect", "message", "inmail", "like", "follow"],
                  description: "Specific action if stepType is linkedin.",
                },
              },
              required: ["stepType", "delayDays"],
            },
          },
          confirmed: {
            type: "boolean",
            description:
              "Set to true only after the user has explicitly confirmed they want to proceed, having seen the preview shown in your previous response. Never set this on the first call for a multi-step sequence.",
          },
        },
        required: ["name", "steps"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "enroll_list",
      description:
        "Enroll every eligible prospect on a list into an active outbound sequence. Use this when the user asks to enroll, start, or launch outreach for a specific list into a specific sequence.",
      parameters: {
        type: "object",
        properties: {
          listId: { type: "string", description: "The list's ID." },
          sequenceId: { type: "string", description: "The sequence's ID." },
          confirmed: {
            type: "boolean",
            description:
              "Set to true only after the user has explicitly confirmed they want to proceed, having seen the preview shown in your previous response. Never set this on the first call.",
          },
        },
        required: ["listId", "sequenceId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "start_enrichment_run",
      description:
        "Start an enrichment workbook run against a list of prospects. Use this when the user asks to enrich, run, or process a list through a workbook.",
      parameters: {
        type: "object",
        properties: {
          workbookId: { type: "string", description: "The enrichment workbook's ID." },
          listId: { type: "string", description: "The list's ID to pull target prospects from." },
          mode: {
            type: "string",
            enum: ["sample", "selected", "changed_rows", "scheduled"],
            description:
              "'sample' tests a handful of rows and is always allowed. The other modes require the workbook to already be active.",
          },
          selectedProspectIds: {
            type: "array",
            items: { type: "string" },
            description: "Required when mode is 'selected' — the exact prospect IDs to run.",
          },
          confirmed: {
            type: "boolean",
            description:
              "Set to true only after the user has explicitly confirmed they want to proceed, having seen the preview shown in your previous response. Never set this on the first call.",
          },
        },
        required: ["workbookId", "listId", "mode"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "draft_content",
      description:
        "Generate an outreach email for one prospect and save it as a pending-review AI draft. Use this when the user asks to draft, write, or compose a message/email for a specific prospect.",
      parameters: {
        type: "object",
        properties: {
          prospectId: { type: "string", description: "The prospect this draft is for." },
          prompt: {
            type: "string",
            description: "What the email should say — tone, angle, offer, or context to reference.",
          },
          confirmed: {
            type: "boolean",
            description:
              "Set to true only after the user has explicitly confirmed they want to proceed, having seen the preview shown in your previous response. Never set this on the first call.",
          },
        },
        required: ["prospectId", "prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "explain_score",
      description:
        "Explain why a prospect has the ICP/signal score they do — returns the per-dimension breakdown and contributing signals, not just the final number. Read-only, no confirmation needed.",
      parameters: {
        type: "object",
        properties: {
          prospectId: { type: "string", description: "The prospect to explain the score for." },
        },
        required: ["prospectId"],
      },
    },
  },
];

/**
 * Builds a runner bound to one workspace. Most handlers are read-only, but a handler that
 * mutates data, spends credits, or has an external side effect MUST register a `previewBuilders`
 * entry so its effects are gated behind an explicit user confirmation — see
 * `create_outbound_sequence` and `enroll_list` for the pattern. The db may be null (returns a
 * friendly error per call).
 */
/**
 * R19.2 — the "cro" agent's tool set is a real allowlist, enforced both in what's offered to the
 * model (`tools`) and at dispatch (`run`) — not just get_cro_summary's own isAdmin check, which
 * only ever gated that one tool while every other read-only workspace tool (get_thread,
 * list_ai_drafts, export_dataset, …) stayed reachable. Only aggregate/admin-scoped tools belong
 * here; nothing here mutates data.
 */
const CRO_AGENT_TOOLS = new Set(["get_cro_summary", "list_app_routes"]);

export function createWorkspaceToolRunner(
  db: Db | null,
  config: Env,
  workspaceId: string,
  /** R19.2 — gates the get_cro_summary tool. Only owner/admin callers should pass true. */
  isAdmin = false,
  /** R19.2 — "cro" restricts both the offered tool list and dispatch to CRO_AGENT_TOOLS. */
  agent: "skout" | "dexter" | "cro" = "skout",
  /** §8.13 — actor for the tool-call audit trail (policy_decisions.detail). Optional: audit is best-effort. */
  userId?: string,
  /** §8.13 — when true, mutating tools execute directly instead of returning a preview (autonomous "auto" mode, or a caller that already confirmed via /ai/execute-tool). */
  confirmMutations = false,
  /** §8.13 SP-06 — orthogonal to `agent`: when a persona declares `allowedToolNames`, tool
   * visibility/dispatch is narrowed the same way CRO_AGENT_TOOLS narrows the "cro" agent —
   * composes with (never loosens) any agent-level restriction already in effect. */
  persona?: CopilotPersona
): WorkspaceToolRunner {
  const personaDef = getCopilotPersonaDef(persona);
  const personaToolNames = personaDef?.allowedToolNames ? new Set(personaDef.allowedToolNames) : null;
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
  const search = db ? createSearchService(config, db) : createSearchService(config, {} as any); // db might be null in some cases
  const regionalBrief = db ? createRegionalBriefService(db) : null;
  const tamService = db ? createCountryIndustryTamService(db) : null;

  const createdExports: ExportArtifact[] = [];
  const createdSequenceIds: string[] = [];
  let pendingToolPreview: ToolActionPreview | null = null;

  const handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
    get_workspace_overview: async () => {
      if (!db) throw new Error("database_unavailable");
      const value = await dashboard.getSummary(workspaceId);
      return evidenceClaim(db, workspaceId, "get_workspace_overview", "workspace", workspaceId, value);
    },

    get_cro_summary: async () => {
      if (!isAdmin) throw new Error("get_cro_summary is admin-only");
      if (!db) throw new Error("database_unavailable");
      const value = await computeCroSummary(db, workspaceId);
      return evidenceClaim(db, workspaceId, "get_cro_summary", "workspace", workspaceId, value);
    },

    get_credit_analytics: async (args) => {
      if (!db) throw new Error("database_unavailable");
      const days = clampInt(args.days, 30, 7, 90);
      const report = await analytics.getReport(workspaceId, days);
      const value = {
        period: report.period,
        credits: report.credits,
        enrichment: report.enrichment,
        lists: report.lists,
      };
      return evidenceClaim(db, workspaceId, "get_credit_analytics", "workspace", workspaceId, value);
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

    get_sequence_analytics: async (args) => {
      if (!sequence) throw new Error("database_unavailable");
      if (!db) throw new Error("database_unavailable");
      const id = String(args.sequenceId ?? "");
      if (!id) throw new Error("sequenceId is required");
      const value = await sequence.getAnalytics(workspaceId, id);
      return evidenceClaim(db, workspaceId, "get_sequence_analytics", "sequence", id, value);
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

    get_deliverability: async () => {
      if (!db) throw new Error("database_unavailable");
      const value = await getDeliverabilityMetrics(db, workspaceId);
      return evidenceClaim(db, workspaceId, "get_deliverability", "workspace", workspaceId, value);
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
      // Return only metadata to the model — the UI surfaces a download button.
      return {
        dataset: artifact.dataset,
        filename: artifact.filename,
        rowCount: artifact.rowCount,
        ready: true,
      };
    },

    search_prospects: async (args) => {
      const query = typeof args.query === "string" ? args.query.trim() : undefined;
      const filters: {
        industry?: string;
        country?: string;
        seniority?: z.infer<typeof seniorityEnum>;
        jobTitle?: string;
      } = {};
      if (typeof args.industry === "string" && args.industry.trim())
        filters.industry = args.industry.trim();
      if (typeof args.country === "string" && args.country.trim())
        filters.country = args.country.trim();
      if (typeof args.title === "string" && args.title.trim()) filters.jobTitle = args.title.trim();
      const seniorityRaw = typeof args.seniority === "string" ? args.seniority.trim() : "";
      if ((seniorityEnum.options as readonly string[]).includes(seniorityRaw)) {
        filters.seniority = seniorityRaw as z.infer<typeof seniorityEnum>;
      }

      const result = await search.searchProspects({
        query: query || undefined,
        filters: Object.keys(filters).length ? filters : undefined,
        page: 1,
        pageSize: 10,
      });

      return {
        freePreview: true,
        creditsCharged: 0,
        total: result.total,
        source: result.source,
        results: result.results.map((p) => ({
          prospectId: p.prospectId,
          fullName: p.fullName,
          title: p.title,
          companyName: p.companyName,
          companyDomain: p.companyDomain,
          industry: p.industry,
          country: p.country,
          seniority: p.seniority,
          icpScore: p.icpScore ?? null,
        })),
        hint: "Open /prospects/search for full filters and paid pagination.",
      };
    },

    get_prospect: async (args) => {
      const prospectId = String(args.prospectId ?? "").trim();
      if (!prospectId) throw new Error("prospectId is required");
      const detail = await search.getProspectById(prospectId);
      if (!detail) return null;
      return {
        prospectId: detail.prospectId,
        fullName: detail.fullName,
        title: detail.title,
        seniority: detail.seniority,
        email: detail.email,
        companyName: detail.companyName,
        companyDomain: detail.companyDomain,
        industry: detail.industry,
        country: detail.country,
        employeeCount: detail.employeeCount,
        icpScore: detail.icpScore,
        intentScore: detail.intentScore,
        outreachReadiness: detail.outreachReadiness,
        painPoints: detail.painPoints,
        signals: detail.signals,
        linkedinUrl: detail.linkedinUrl,
      };
    },

    list_enrichment_jobs: async (args) => {
      const limit = clampInt(args.limit, 20, 1, MAX_ROWS);
      const jobs = await enrichment.listJobs(workspaceId);
      return jobs.slice(0, limit).map((j) => ({
        id: j.id,
        prospectId: j.prospectId,
        status: j.status,
        creditsUsed: j.creditsUsed,
        queuedAt: j.queuedAt,
        completedAt: j.completedAt,
        errorMessage: j.errorMessage,
      }));
    },

    list_app_routes: async () => APP_ROUTES,

    get_regional_selling_brief: async (args) => {
      if (!regionalBrief) throw new Error("database_unavailable");
      if (!db) throw new Error("database_unavailable");
      const country = String(args.country ?? "").trim();
      const industry = args.industry ? String(args.industry).trim() : undefined;
      if (!country) return { error: "country is required" };
      const value = await regionalBrief.resolveRegionalBrief({ countryIso: country, industry, workspaceId });
      return evidenceClaim(
        db,
        workspaceId,
        "get_regional_selling_brief",
        "regional_brief",
        `${country}:${industry ?? "*"}`,
        value
      );
    },

    get_market_tam: async (args) => {
      if (!tamService) throw new Error("database_unavailable");
      if (!db) throw new Error("database_unavailable");
      const country = String(args.country ?? "").trim();
      const industry = String(args.industry ?? "").trim();
      if (!country || !industry) return { error: "country and industry are required" };
      const icpPct = typeof args.icpFitPct === "number" ? args.icpFitPct : undefined;
      const acvUsd = typeof args.acvUsd === "number" ? args.acvUsd : undefined;
      const value = await tamService.getTam({
        countryIso: country,
        naicsCode: industry,
        icpPctOverride: icpPct,
        acvUsdOverride: acvUsd,
      });
      return evidenceClaim(db, workspaceId, "get_market_tam", "country_industry_tam", `${country}:${industry}`, value);
    },

    create_outbound_sequence: async (args) => {
      if (!sequence) throw new Error("database_unavailable");
      const name =
        typeof args.name === "string" && args.name.trim() ? args.name.trim() : "Outbound Cadence";
      const rawSteps = Array.isArray(args.steps) ? (args.steps as Record<string, unknown>[]) : [];
      if (rawSteps.length === 0) {
        return { error: "at_least_one_step_required" };
      }
      const formattedSteps = rawSteps.map((s, idx) => ({
        stepType: (["email", "linkedin", "whatsapp", "call", "wait", "task"].includes(String(s.stepType))
          ? String(s.stepType)
          : "email") as any,
        delayDays: typeof s.delayDays === "number" && s.delayDays >= 0 ? s.delayDays : idx === 0 ? 0 : 3,
        delayUnit: "days" as const,
        subject:
          typeof s.subject === "string" ? s.subject : s.stepType === "email" ? "Quick question" : undefined,
        bodyTemplate:
          typeof s.bodyTemplate === "string" && s.bodyTemplate.trim()
            ? s.bodyTemplate
            : `<p>Hi {{firstName}},</p><p>Reaching out regarding {{companyName}}.</p><p style="font-size:11px;color:#888"><a href="{{unsubscribeUrl}}">Unsubscribe</a></p>`,
        linkedinAction:
          s.stepType === "linkedin"
            ? (["connect", "message", "inmail", "like", "follow"].includes(String(s.linkedinAction))
                ? (String(s.linkedinAction) as any)
                : "connect")
            : undefined,
      }));

      const seq = await sequence.createGeneratedSequence(workspaceId, {
        name,
        source: "dexter",
        mode: "A",
        steps: formattedSteps,
      });

      createdSequenceIds.push(seq.id);

      return {
        success: true,
        sequenceId: seq.id,
        name: seq.name,
        stepsCount: seq.steps.length,
        status: seq.status,
        path: `/sequences/${seq.id}`,
        message: `Sequence "${seq.name}" with ${seq.steps.length} steps created successfully in your workspace!`,
      };
    },

    enroll_list: async (args) => {
      if (!db) throw new Error("database_unavailable");
      const listId = String(args.listId ?? "");
      const sequenceId = String(args.sequenceId ?? "");
      if (!listId || !sequenceId) return { error: "listId and sequenceId are required" };
      if (!userId) return { error: "actor_unknown" };
      return enrollListWithSideEffects(db, config, workspaceId, listId, sequenceId, userId, agent);
    },

    start_enrichment_run: async (args) => {
      if (!db) throw new Error("database_unavailable");
      const workbookId = String(args.workbookId ?? "");
      const listId = String(args.listId ?? "");
      const mode = String(args.mode ?? "");
      if (!workbookId || !listId || !mode) return { error: "workbookId, listId, and mode are required" };
      if (!["sample", "selected", "changed_rows", "scheduled"].includes(mode)) {
        return { error: "invalid_mode" };
      }
      const selectedProspectIds = Array.isArray(args.selectedProspectIds)
        ? (args.selectedProspectIds as unknown[]).map(String)
        : undefined;
      try {
        const run = await startWorkbookRun(db, config, workspaceId, workbookId, {
          listId,
          mode: mode as "sample" | "selected" | "changed_rows" | "scheduled",
          selectedProspectIds,
        });
        return {
          success: true,
          runId: run.id,
          status: run.status,
          totalRows: run.totalRows,
          path: `/workbooks/${workbookId}/runs/${run.id}`,
          message: `Enrichment run started — processing ${run.totalRows} row(s).`,
        };
      } catch (err) {
        return { error: err instanceof Error ? err.message : "failed_to_start_run" };
      }
    },

    draft_content: async (args) => {
      if (!db || !drafts) throw new Error("database_unavailable");
      const prospectId = String(args.prospectId ?? "").trim();
      const prompt = String(args.prompt ?? "").trim();
      if (!prospectId || !prompt) return { error: "prospectId and prompt are required" };

      const generated = await aiService.generateEmail(prompt, config.OPENROUTER_API_KEY);
      const draft = await drafts.create(workspaceId, {
        prospectId,
        subject: generated.subject,
        body: generated.html,
        model: process.env.AI_MODEL ?? "openai/gpt-4o-mini",
      });

      return {
        success: true,
        draftId: draft.id,
        subject: draft.subject,
        status: draft.status,
        path: "/ai/drafts",
        message: `Draft "${draft.subject}" created and pending review.`,
      };
    },

    explain_score: async (args) => {
      if (!db) throw new Error("database_unavailable");
      const prospectId = String(args.prospectId ?? "").trim();
      if (!prospectId) return { error: "prospectId is required" };

      const prospect = await search.getProspectById(prospectId);
      if (!prospect) return { error: "prospect_not_found" };

      const icp = await getWorkspaceIcp(db, workspaceId);
      const icpVersion = await getWorkspaceIcpVersion(db, workspaceId);
      const scoreInput: ScoreInput = {
        prospectId: prospect.prospectId,
        fullName: prospect.fullName ?? undefined,
        title: prospect.title ?? undefined,
        seniority: prospect.seniority ?? undefined,
        industry: prospect.industry ?? undefined,
        country: prospect.country ?? undefined,
        employeeCount: prospect.employeeCount ?? undefined,
        companyDomain: prospect.companyDomain ?? undefined,
        signals: (prospect.signals ?? []).map((s) => s.type),
      };
      // Local heuristic scorer, not the LLM path (scoreProspectIcp) — this is a free, synchronous
      // re-derivation of the same weighting logic already used as apps/ai's fallback, appropriate
      // for a read-only "explain" tool that shouldn't itself cost credits or call an external model.
      const icpBreakdown = scoreIcpFitLocally(scoreInput, icp);

      const signalRows = await listSignalsForEntity(db, prospectId, { entityType: "prospect" });
      const weights = signalStackWeightsFromEnv(config);
      const signalStack = computeSignalStackScore(signalRows, { weights });

      const value = {
        prospectId,
        icp: {
          score: icpBreakdown.icpScore,
          band: icpBreakdown.icpBand,
          version: icpVersion,
          source: icpBreakdown.source,
          dimensions: icpBreakdown.dimensions,
          reasoning: icpBreakdown.reasoning,
        },
        signalStack: {
          score: signalStack.score,
          band: signalStack.band,
          distinctSignalTypes: signalStack.distinctSignalTypes,
          reachableDecisionMaker: signalStack.reachableDecisionMaker,
          contributingSignals: signalStack.contributingSignals,
          weights,
        },
      };
      return evidenceClaim(db, workspaceId, "explain_score", "prospect", prospectId, value);
    },
  };

  const previewBuilders: Record<string, (args: Record<string, unknown>) => ActionPreview | Promise<ActionPreview>> = {
    create_outbound_sequence: (args) => {
      const name = typeof args.name === "string" && args.name.trim() ? args.name.trim() : "Outbound Cadence";
      const rawSteps = Array.isArray(args.steps) ? (args.steps as Record<string, unknown>[]) : [];
      return {
        toolName: "create_outbound_sequence",
        scope: `Create a new outbound sequence "${name}" with ${rawSteps.length} step(s).`,
        assumptions: rawSteps.length === 0 ? ["No steps provided — the sequence will fail validation."] : [],
        affectedRecordCount: rawSteps.length,
        creditCost: 0,
        externalSideEffects: rawSteps.some((s) => s.stepType === "linkedin")
          ? ["Will send LinkedIn actions once prospects are enrolled into this sequence"]
          : [],
      };
    },

    enroll_list: async (args) => {
      const listId = String(args.listId ?? "");
      const sequenceId = String(args.sequenceId ?? "");
      let memberCount = 0;
      if (db && listId) {
        const [row] = await db
          .select({ count: count() })
          .from(listMembers)
          .innerJoin(lists, eq(lists.id, listMembers.listId))
          .where(scopedTo(lists, workspaceId, eq(listMembers.listId, listId)));
        memberCount = row?.count ?? 0;
      }
      return {
        toolName: "enroll_list",
        scope: `Enroll ${memberCount} prospect(s) from this list into the sequence.`,
        assumptions: !listId || !sequenceId ? ["Missing listId or sequenceId — will fail validation."] : [],
        affectedRecordCount: memberCount,
        creditCost: 0,
        externalSideEffects: ["Enqueues outreach sends for each newly enrolled prospect", "Dispatches a prospect.enrolled webhook per enrollment"],
      };
    },

    start_enrichment_run: async (args) => {
      const workbookId = String(args.workbookId ?? "");
      const listId = String(args.listId ?? "");
      const mode = String(args.mode ?? "");
      let memberCount = 0;
      let budgetCreditsPerRun: number | null = null;
      if (db && listId) {
        const [row] = await db
          .select({ count: count() })
          .from(listMembers)
          .innerJoin(lists, eq(lists.id, listMembers.listId))
          .where(and(eq(listMembers.listId, listId), eq(lists.workspaceId, workspaceId)));
        memberCount = row?.count ?? 0;
      }
      if (db && workbookId) {
        const workbook = await getWorkbook(db, workspaceId, workbookId);
        budgetCreditsPerRun = workbook?.budgetCreditsPerRun ?? null;
      }
      const assumptions: string[] = [];
      if (!workbookId || !listId || !mode) assumptions.push("Missing workbookId, listId, or mode — will fail validation.");
      if (mode === "sample") assumptions.push("'sample' mode only processes a small test batch, not the full list count shown here.");
      return {
        toolName: "start_enrichment_run",
        scope: `Run the enrichment workbook against ~${memberCount} prospect(s) on this list (mode: ${mode || "unspecified"}).`,
        assumptions,
        affectedRecordCount: memberCount,
        creditCost: budgetCreditsPerRun ?? 0,
        externalSideEffects: ["Calls enrichment providers per row, consuming workspace credits"],
      };
    },

    draft_content: (args) => {
      const prospectId = String(args.prospectId ?? "");
      const prompt = String(args.prompt ?? "").trim();
      return {
        toolName: "draft_content",
        scope: prospectId
          ? `Draft an outreach email for prospect ${prospectId}: "${prompt.slice(0, 120)}"`
          : "Draft an outreach email.",
        assumptions: !prospectId || !prompt ? ["Missing prospectId or prompt — will fail validation."] : [],
        affectedRecordCount: 1,
        creditCost: 0,
        externalSideEffects: ["Calls the configured LLM provider to generate content", "Creates a pending-review AI draft"],
      };
    },
  };

  let tools =
    agent === "cro"
      ? WORKSPACE_TOOL_DEFS.filter((t) => t.type === "function" && CRO_AGENT_TOOLS.has(t.function.name))
      : WORKSPACE_TOOL_DEFS;
  if (personaToolNames) {
    tools = tools.filter((t) => t.type === "function" && personaToolNames.has(t.function.name));
  }

  return {
    tools,
    getCreatedExports: () => createdExports,
    getCreatedSequenceIds: () => createdSequenceIds,
    getPendingToolPreview: () => pendingToolPreview,
    async run(name, args) {
      if (agent === "cro" && !CRO_AGENT_TOOLS.has(name)) {
        log.warn("cro agent attempted a non-allowlisted tool call", { tool: name, workspaceId });
        return serialize({ error: `tool_not_available_for_agent:${name}` });
      }
      if (personaToolNames && !personaToolNames.has(name)) {
        log.warn("persona attempted a tool outside its allowlist", { tool: name, persona, workspaceId });
        return serialize({ error: `tool_not_available_for_persona:${name}` });
      }
      const handler = handlers[name];
      if (!handler) return serialize({ error: `unknown_tool:${name}` });

      const previewBuilder = previewBuilders[name];
      let execArgs = args ?? {};
      if (previewBuilder) {
        const key = pendingPreviewKey(workspaceId, name);
        if (execArgs.confirmed === true || confirmMutations) {
          // Confirming: execute the EXACT args the preview was computed from, never whatever the
          // model resupplied — see the pendingPreviews doc comment for why. Fall back to the
          // model-supplied args only if there's no matching cached preview (e.g. it expired, or
          // the model confirmed something it never actually previewed) — this preserves today's
          // behavior for that edge case rather than hard-failing it.
          const cached = pendingPreviews.get(key);
          if (cached && cached.expiresAt > Date.now()) {
            execArgs = { ...cached.args, confirmed: true };
          }
          pendingPreviews.delete(key);
        } else {
          try {
            const preview = await previewBuilder(execArgs);
            if (db) {
              try {
                await classifyAndRecord(db, {
                  workspaceId,
                  actionKey: `tool:${name}`,
                  actorUserId: userId,
                  detail: preview as unknown as Record<string, unknown>,
                });
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                log.warn("failed to record tool-call audit decision", { tool: name, workspaceId, err: message });
              }
            }
            if (requiresConfirmation(preview)) {
              pendingPreviews.set(key, { args: execArgs, expiresAt: Date.now() + PENDING_PREVIEW_TTL_MS });
              return serialize({
                preview,
                requiresConfirmation: true,
                nextStep:
                  "Relay this preview to the user in your reply and stop. Do not call this tool again in this same turn. Once the user explicitly agrees in a later message, call this exact tool again with ONLY confirmed: true — you do not need to resupply the other arguments, the server remembers them from this preview.",
              });
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.warn("preview builder failed", { tool: name, workspaceId, err: message });
            return serialize({ error: message });
          }
        }
      }

      try {
        const result = await handler(execArgs);
        return serialize(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("workspace tool failed", { tool: name, workspaceId, err: message });
        return serialize({ error: message });
      }
    },
  };
}