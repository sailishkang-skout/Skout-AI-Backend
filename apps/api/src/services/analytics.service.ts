import { and, desc, eq, gte } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { buildEnrichmentService } from "./enrichment/index.js";
import { createWorkspaceService } from "./workspace.service.js";
import type { Env } from "../config/env.js";

/** Local calendar date (YYYY-MM-DD) — matches buildDailySeries buckets. */
function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function buildDailySeries(days: number): string[] {
  const keys: string[] = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(cursor);
    d.setDate(cursor.getDate() - i);
    keys.push(dayKey(d));
  }
  return keys;
}


export function createAnalyticsService(db: Db | null, config: Env) {
  const enrichmentSvc = buildEnrichmentService(db, config);
  const workspaceSvc = db ? createWorkspaceService(db) : null;

  return {
    async getReport(workspaceId: string, days = 30) {
      const periodDays = Math.min(Math.max(days, 7), 90);
      const since = new Date();
      since.setHours(0, 0, 0, 0);
      since.setDate(since.getDate() - (periodDays - 1));

      const balance = await enrichmentSvc.getCredits(workspaceId);
      const lists = await enrichmentSvc.listLists(workspaceId);
      const jobs = await enrichmentSvc.listJobs(workspaceId);

      const jobsInPeriod = jobs.filter((j) => new Date(j.queuedAt) >= since);
      const completedJobs = jobsInPeriod.filter((j) => j.status === "completed");
      const failedJobs = jobsInPeriod.filter((j) => j.status === "failed");
      const runningJobs = jobsInPeriod.filter(
        (j) => j.status === "running" || j.status === "queued"
      );

      const dailyMap = new Map(
        buildDailySeries(periodDays).map((date) => [
          date,
          { spent: 0, added: 0, jobs: 0, completed: 0 },
        ])
      );

      let transactions: Array<{
        id: string;
        amount: number;
        action: string;
        referenceId: string | null;
        createdAt: string;
      }> = [];

      if (db) {
        const rows = await db
          .select()
          .from(schema.creditTransactions)
          .where(
            and(
              eq(schema.creditTransactions.workspaceId, workspaceId),
              gte(schema.creditTransactions.createdAt, since)
            )
          )
          .orderBy(desc(schema.creditTransactions.createdAt));

        transactions = rows.map((r) => ({
          id: r.id,
          amount: r.amount,
          action: r.action,
          referenceId: r.referenceId,
          createdAt: r.createdAt.toISOString(),
        }));
      }

      const actionTotals = new Map<string, number>();
      let creditsSpent = 0;
      let creditsAdded = 0;

      for (const tx of transactions) {
        const key = dayKey(new Date(tx.createdAt));
        const bucket = dailyMap.get(key);
        if (tx.amount < 0) {
          creditsSpent += Math.abs(tx.amount);
          if (bucket) bucket.spent += Math.abs(tx.amount);
          actionTotals.set(tx.action, (actionTotals.get(tx.action) ?? 0) + Math.abs(tx.amount));
        } else if (tx.amount > 0) {
          creditsAdded += tx.amount;
          if (bucket) bucket.added += tx.amount;
        }
      }

      for (const job of jobsInPeriod) {
        const key = dayKey(new Date(job.queuedAt));
        const bucket = dailyMap.get(key);
        if (bucket) {
          bucket.jobs += 1;
          if (job.status === "completed") bucket.completed += 1;
        }
      }

      const byAction = [...actionTotals.entries()]
        .map(([action, credits]) => ({ action, credits }))
        .sort((a, b) => b.credits - a.credits);

      const daily = [...dailyMap.entries()].map(([date, v]) => ({
        date,
        spent: v.spent,
        added: v.added,
        jobs: v.jobs,
        completed: v.completed,
      }));

      const enrichmentCredits = jobsInPeriod.reduce((sum, j) => sum + (j.creditsUsed ?? 0), 0);
      const finished = completedJobs.length + failedJobs.length;
      const successRate = finished > 0 ? Math.round((completedJobs.length / finished) * 100) : 0;

      let workspaceName = "Workspace";
      if (workspaceSvc) {
        const ws = await workspaceSvc.getWorkspaceById(workspaceId);
        if (ws) workspaceName = ws.name;
      }

      return {
        workspaceName,
        period: {
          days: periodDays,
          from: since.toISOString(),
          to: new Date().toISOString(),
        },
        credits: {
          balance,
          spent: creditsSpent,
          added: creditsAdded,
          net: creditsAdded - creditsSpent,
          byAction,
          daily: daily.map(({ date, spent, added }) => ({ date, spent, added })),
        },
        enrichment: {
          totalJobs: jobsInPeriod.length,
          completed: completedJobs.length,
          failed: failedJobs.length,
          running: runningJobs.length,
          successRate,
          creditsUsed: enrichmentCredits,
          daily: daily.map(({ date, jobs: j, completed }) => ({ date, jobs: j, completed })),
        },
        lists: {
          count: lists.length,
          totalProspects: lists.reduce((sum, l) => sum + l.prospectCount, 0),
        },
        recentTransactions: transactions
          .slice()
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 25),
      };
    },
  };
}

export type AnalyticsReport = Awaited<ReturnType<ReturnType<typeof createAnalyticsService>["getReport"]>>;
