import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { and, eq, gte, sql } from "drizzle-orm";
import { createWorkspaceService } from "./workspace.service.js";
import { buildEnrichmentService } from "./enrichment/index.js";
import type { Env } from "../config/env.js";

function weekAgo(): Date {
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
}

export function createDashboardService(db: Db | null, config: Env) {
  const workspaceSvc = db ? createWorkspaceService(db) : null;
  const enrichmentSvc = buildEnrichmentService(db, config);

  return {
    async getSummary(workspaceId: string) {
      const balance = await enrichmentSvc.getCredits(workspaceId);
      const lists = await enrichmentSvc.listLists(workspaceId);
      const listCount = lists.length;
      const totalProspectsInLists = lists.reduce((sum, l) => sum + l.prospectCount, 0);
      const jobs = (await enrichmentSvc.listJobs(workspaceId)).slice(0, 5);

      let workspaceName = "Workspace";
      if (workspaceSvc) {
        const ws = await workspaceSvc.getWorkspaceById(workspaceId);
        if (ws) workspaceName = ws.name;
      }

      let icpConfigured = false;
      let searchesThisWeek = 0;
      let enrichedThisWeek = 0;
      let exportsThisWeek = 0;

      if (db) {
        const since = weekAgo();
        const [icpRow] = await db
          .select()
          .from(schema.workspaceIcp)
          .where(eq(schema.workspaceIcp.workspaceId, workspaceId))
          .limit(1);
        if (icpRow?.config && typeof icpRow.config === "object") {
          const cfg = icpRow.config as Record<string, unknown>;
          icpConfigured = Boolean(
            (Array.isArray(cfg.industries) && cfg.industries.length) ||
              (Array.isArray(cfg.countries) && cfg.countries.length) ||
              (Array.isArray(cfg.seniorities) && cfg.seniorities.length) ||
              cfg.minEmployees != null ||
              cfg.maxEmployees != null
          );
        }

        const weekly = await db
          .select({
            action: schema.creditTransactions.action,
            total: sql<number>`count(*)::int`,
          })
          .from(schema.creditTransactions)
          .where(
            and(
              eq(schema.creditTransactions.workspaceId, workspaceId),
              gte(schema.creditTransactions.createdAt, since)
            )
          )
          .groupBy(schema.creditTransactions.action);

        for (const row of weekly) {
          if (row.action === "search") searchesThisWeek = row.total;
          if (row.action === "enrichment" || row.action === "ai_score") {
            enrichedThisWeek += row.total;
          }
          if (row.action.startsWith("export")) exportsThisWeek += row.total;
        }
      }

      return {
        workspaceName,
        credits: balance,
        listCount,
        totalProspectsInLists,
        icpConfigured,
        searchesThisWeek,
        enrichedThisWeek,
        exportsThisWeek,
        recentJobs: jobs.map((j) => ({
          id: j.id,
          prospectId: j.prospectId,
          status: j.status,
          creditsUsed: j.creditsUsed,
          queuedAt: j.queuedAt,
          completedAt: j.completedAt,
        })),
      };
    },
  };
}
