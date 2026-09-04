import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { listDecisions, listPolicies } from "./policy-gateway.service.js";
import { listDecisionViews } from "./decision-workflow.service.js";
import { computeDexterPlanMetrics, computeWorkspaceEvaluationSummary } from "./dexter-evaluation-loop.service.js";

const { dexterPlans, policyDecisions } = schema;

/** §8.7 — Dexter AI SDR Command Center aggregate read model. */
export async function getDexterCommandCenter(db: Db, workspaceId: string) {
  const [plans, policies, policyBlocks, openDecisions, recentDecisions, evaluationSummary] = await Promise.all([
    db
      .select()
      .from(dexterPlans)
      .where(eq(dexterPlans.workspaceId, workspaceId))
      .orderBy(desc(dexterPlans.createdAt))
      .limit(20),
    listPolicies(db, workspaceId),
    db
      .select()
      .from(policyDecisions)
      .where(and(eq(policyDecisions.workspaceId, workspaceId), eq(policyDecisions.outcome, "denied")))
      .orderBy(desc(policyDecisions.createdAt))
      .limit(10),
    listDecisionViews(db, workspaceId, "open"),
    listDecisions(db, workspaceId),
    // §7.3 Evaluation Loop — workspace-wide accepted-vs-overridden rate.
    computeWorkspaceEvaluationSummary(db, workspaceId),
  ]);

  const pendingApprovals = plans.filter((p) => p.status === "proposed");
  const approvedPlans = plans.filter((p) => p.status === "approved" || p.status === "invoked" || p.status === "learned");
  const invokedPlans = plans.filter((p) => p.status === "invoked" || p.status === "learned");

  // §7.3 Evaluation Loop — per-plan decision/reply-rate/meeting-rate, computed on read
  // alongside the rest of this already-uncached read model (see dexter-evaluation-loop.service.ts).
  const planMetrics = await Promise.all(plans.map((p) => computeDexterPlanMetrics(db, workspaceId, p.id)));

  return {
    summary: {
      pendingPlanApprovals: pendingApprovals.length,
      approvedPlans: approvedPlans.length,
      invokedPlans: invokedPlans.length,
      openDecisions: openDecisions.length,
      policyBlocks: policyBlocks.length,
      evaluation: evaluationSummary,
    },
    plans: plans.map((p, i) => ({
      id: p.id,
      brief: p.brief,
      status: p.status,
      policyMode: p.policyMode,
      proposal: p.proposal,
      createdAt: p.createdAt,
      approvedAt: p.approvedAt,
      invokedAt: p.invokedAt,
      rejectedAt: p.rejectedAt,
      decision: planMetrics[i]?.decision ?? "pending",
      replyRate: planMetrics[i]?.replyRate ?? null,
      meetingRate: planMetrics[i]?.meetingRate ?? null,
    })),
    pendingApprovals,
    policyBlocks,
    policies,
    openDecisions,
    recentPolicyDecisions: recentDecisions.slice(0, 12),
    experiments: [],
    spend: { aiCreditsEstimate: 0, note: "Connect billing ledger for live AI spend" },
  };
}

export async function listDexterPlans(db: Db, workspaceId: string, status?: string) {
  const rows = await db
    .select()
    .from(dexterPlans)
    .where(
      status
        ? and(eq(dexterPlans.workspaceId, workspaceId), eq(dexterPlans.status, status))
        : eq(dexterPlans.workspaceId, workspaceId)
    )
    .orderBy(desc(dexterPlans.createdAt))
    .limit(50);
  return rows;
}
