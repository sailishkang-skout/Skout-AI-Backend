import { desc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo } from "@skout/db";
import { listDecisions, listPolicies } from "./policy-gateway.service.js";
import { listDecisionViews } from "./decision-workflow.service.js";

const { dexterPlans, policyDecisions } = schema;

/** §8.7 — Dexter AI SDR Command Center aggregate read model. */
export async function getDexterCommandCenter(db: Db, workspaceId: string) {
  const [plans, policies, policyBlocks, openDecisions, recentDecisions] = await Promise.all([
    db
      .select()
      .from(dexterPlans)
      .where(scopedTo(dexterPlans, workspaceId))
      .orderBy(desc(dexterPlans.createdAt))
      .limit(20),
    listPolicies(db, workspaceId),
    db
      .select()
      .from(policyDecisions)
      .where(scopedTo(policyDecisions, workspaceId, eq(policyDecisions.outcome, "denied")))
      .orderBy(desc(policyDecisions.createdAt))
      .limit(10),
    listDecisionViews(db, workspaceId, "open"),
    listDecisions(db, workspaceId),
  ]);

  const pendingApprovals = plans.filter((p) => p.status === "proposed");
  const approvedPlans = plans.filter((p) => p.status === "approved" || p.status === "invoked" || p.status === "learned");
  const invokedPlans = plans.filter((p) => p.status === "invoked" || p.status === "learned");

  return {
    summary: {
      pendingPlanApprovals: pendingApprovals.length,
      approvedPlans: approvedPlans.length,
      invokedPlans: invokedPlans.length,
      openDecisions: openDecisions.length,
      policyBlocks: policyBlocks.length,
    },
    plans: plans.map((p) => ({
      id: p.id,
      brief: p.brief,
      status: p.status,
      policyMode: p.policyMode,
      proposal: p.proposal,
      createdAt: p.createdAt,
      approvedAt: p.approvedAt,
      invokedAt: p.invokedAt,
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
    .where(scopedTo(dexterPlans, workspaceId, status ? eq(dexterPlans.status, status) : undefined))
    .orderBy(desc(dexterPlans.createdAt))
    .limit(50);
  return rows;
}
