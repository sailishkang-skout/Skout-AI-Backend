import type { Db } from "@skout/db";
import { schema, scopedTo } from "@skout/db";
import { count, eq } from "drizzle-orm";
import type { Env } from "../config/env.js";
import { createDashboardService } from "./dashboard.service.js";
import { buildEnrichmentService } from "./enrichment/index.js";
import { appGuidesToPrompt, selectAppGuides } from "../content/app-guides.js";
import { createLogger } from "@skout/observability";

const log = createLogger("ai-chat-context");

export interface ChatGrounding {
  workspaceFacts: string;
  appGuides: string;
}

/**
 * Build grounded context for AI chat: live workspace stats + product how-to snippets.
 * Failures are swallowed so chat still works if one data source is down.
 */
export async function buildChatGrounding(
  db: Db | null,
  config: Env,
  workspaceId: string,
  opts?: { userMessage?: string; page?: string }
): Promise<ChatGrounding> {
  const guides = selectAppGuides({
    userMessage: opts?.userMessage,
    page: opts?.page,
    limit: 4,
  });
  const appGuides = appGuidesToPrompt(guides);

  if (!db) {
    return {
      workspaceFacts: "Workspace database is not connected — cannot load live stats.",
      appGuides,
    };
  }

  try {
    const dash = createDashboardService(db, config);
    const summary = await dash.getSummary(workspaceId);

    let listLines: string[] = [];
    try {
      const enrichment = buildEnrichmentService(db, config);
      const allLists = await enrichment.listLists(workspaceId);
      listLines = allLists
        .slice(0, 8)
        .map((l) => `- ${l.name}: ${l.prospectCount} prospects`);
    } catch {
      /* ignore */
    }

    let sequenceCount = 0;
    let inboxCount = 0;
    let unreadApprox = 0;
    let recentDrafts = 0;

    try {
      const [seqRow] = await db
        .select({ n: count() })
        .from(schema.sequences)
        .where(scopedTo(schema.sequences, workspaceId));
      sequenceCount = seqRow?.n ?? 0;
    } catch {
      /* ignore */
    }
    try {
      const [inboxRow] = await db
        .select({ n: count() })
        .from(schema.inboxes)
        .where(scopedTo(schema.inboxes, workspaceId, eq(schema.inboxes.status, "active")));
      inboxCount = inboxRow?.n ?? 0;
    } catch {
      /* ignore */
    }
    try {
      const [threadRow] = await db
        .select({ n: count() })
        .from(schema.inboxThreads)
        .where(
          scopedTo(schema.inboxThreads, workspaceId, eq(schema.inboxThreads.status, "new"))
        );
      unreadApprox = threadRow?.n ?? 0;
    } catch {
      /* ignore */
    }
    try {
      const [draftRow] = await db
        .select({ n: count() })
        .from(schema.aiDrafts)
        .where(
          scopedTo(schema.aiDrafts, workspaceId, eq(schema.aiDrafts.status, "pending_review"))
        );
      recentDrafts = draftRow?.n ?? 0;
    } catch {
      /* ignore */
    }

    const lines = [
      `Workspace: ${summary.workspaceName} (id ${workspaceId})`,
      `Credits balance: ${summary.credits}`,
      `Lists: ${summary.listCount} (total prospects in lists: ${summary.totalProspectsInLists})`,
      `ICP configured: ${summary.icpConfigured ? "yes" : "no"}`,
      `Sequences: ${sequenceCount}`,
      `Active sending inboxes: ${inboxCount}`,
      `Inbox threads marked new: ${unreadApprox}`,
      `AI drafts pending review: ${recentDrafts}`,
      `This week — searches: ${summary.searchesThisWeek}, enrich/score jobs: ${summary.enrichedThisWeek}, exports: ${summary.exportsThisWeek}`,
    ];
    if (listLines.length) {
      lines.push("Top lists:");
      lines.push(...listLines);
    }
    if (opts?.page) lines.push(`User is currently on page: ${opts.page}`);

    return { workspaceFacts: lines.join("\n"), appGuides };
  } catch (err) {
    log.warn("Failed to build workspace chat facts", { err, workspaceId });
    return {
      workspaceFacts: "Live workspace stats unavailable right now.",
      appGuides,
    };
  }
}
