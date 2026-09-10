import type { Db } from "@skout/db";
import { schema, scopedTo } from "@skout/db";
import { eq, gte, sql } from "drizzle-orm";
import { createWorkspaceService } from "./workspace.service.js";
import { buildEnrichmentService } from "./enrichment/index.js";
import type { Env } from "../config/env.js";

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function weekAgo(): Date {
  return daysAgo(7);
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
          .where(scopedTo(schema.workspaceIcp, workspaceId))
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
            scopedTo(schema.creditTransactions, workspaceId, gte(schema.creditTransactions.createdAt, since))
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

    /**
     * GTM revamp — GTM Funnel chart data: real "discovered → enriched → in sequence → replied"
     * counts over the trailing `days` window, plus a live (not date-windowed) count of currently
     * active sequence enrollments for the "Active in Sequence" KPI card. The funnel's final two
     * stages (meetings booked, opportunities created) live in apps/crm and are composed
     * client-side — apps/api has no server-to-server path into CRM's tables (§7.1).
     */
    async getFunnel(workspaceId: string, days = 30) {
      if (!db) {
        return { discovered: 0, enriched: 0, inSequence: 0, replied: 0, activeInSequence: 0 };
      }

      const since = daysAgo(days);

      const [{ discovered }] = await db
        .select({ discovered: sql<number>`count(*)::int` })
        .from(schema.prospectActivations)
        .where(scopedTo(schema.prospectActivations, workspaceId, gte(schema.prospectActivations.activatedAt, since)));

      const enrichedRows = await db
        .select({ action: schema.creditTransactions.action, total: sql<number>`count(*)::int` })
        .from(schema.creditTransactions)
        .where(scopedTo(schema.creditTransactions, workspaceId, gte(schema.creditTransactions.createdAt, since)))
        .groupBy(schema.creditTransactions.action);
      let enriched = 0;
      for (const row of enrichedRows) {
        if (row.action === "enrichment" || row.action === "ai_score") enriched += row.total;
      }

      const [{ inSequence }] = await db
        .select({ inSequence: sql<number>`count(*)::int` })
        .from(schema.sequenceEnrollments)
        .where(scopedTo(schema.sequenceEnrollments, workspaceId, gte(schema.sequenceEnrollments.enrolledAt, since)));

      const [{ replied }] = await db
        .select({ replied: sql<number>`count(*)::int` })
        .from(schema.sequenceEnrollments)
        .where(
          scopedTo(
            schema.sequenceEnrollments,
            workspaceId,
            eq(schema.sequenceEnrollments.status, "replied"),
            gte(schema.sequenceEnrollments.completedAt, since)
          )
        );

      const [{ activeInSequence }] = await db
        .select({ activeInSequence: sql<number>`count(*)::int` })
        .from(schema.sequenceEnrollments)
        .where(scopedTo(schema.sequenceEnrollments, workspaceId, eq(schema.sequenceEnrollments.status, "active")));

      return { discovered, enriched, inSequence, replied, activeInSequence };
    },
  };
}
