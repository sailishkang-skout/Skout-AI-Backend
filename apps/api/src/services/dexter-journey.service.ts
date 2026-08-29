import { and, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { HttpError } from "../utils/http.js";
import { classifyAndRecord, assertAllowed } from "./policy-gateway.service.js";
import { incrJourneyMetric } from "./journey-metrics.js";

export {
  checkLinkedinVoiceEligibility,
  confirmLinkedinVoiceSent,
  createLinkedinVoiceHandoff,
  draftLinkedinVoiceScript,
  getLinkedinVoiceHandoff,
  listLinkedinVoiceHandoffs,
  synthesizeVoiceAudio,
} from "./linkedin-voice.service.js";

const { dexterPlans } = schema;

export async function proposeDexterPlan(
  db: Db,
  opts: { workspaceId: string; brief: string; userId?: string }
) {
  const classify = await classifyAndRecord(db, {
    workspaceId: opts.workspaceId,
    actionKey: "dexter.plan_invoke",
    actorUserId: opts.userId,
    detail: { phase: "propose" },
  });

  const proposal = {
    steps: [
      { id: "brief_approval", status: "pending" },
      { id: "policy_gateway_classify", status: "done", mode: classify.mode },
      { id: "post_approval_invoke", status: "blocked_until_approve" },
      { id: "outcome_hypothesis_attribution", status: "pending" },
      { id: "learning_update_threshold", status: "pending" },
    ],
    hypothesis: `Executing brief: ${opts.brief.slice(0, 200)}`,
  };

  const [plan] = await db
    .insert(dexterPlans)
    .values({
      workspaceId: opts.workspaceId,
      brief: opts.brief,
      proposal,
      status: "proposed",
      policyMode: classify.mode,
      policyDecisionId: classify.decisionId,
      createdBy: opts.userId,
    })
    .returning();

  return { plan: plan!, policy: classify };
}

export async function approveDexterPlan(db: Db, workspaceId: string, planId: string) {
  const [plan] = await db
    .select()
    .from(dexterPlans)
    .where(and(eq(dexterPlans.id, planId), eq(dexterPlans.workspaceId, workspaceId)))
    .limit(1);
  if (!plan) throw new HttpError("Dexter plan not found", 404);
  if (plan.status !== "proposed") throw new HttpError(`Plan status is ${plan.status}`, 422);

  const [updated] = await db
    .update(dexterPlans)
    .set({ status: "approved", approvedAt: new Date() })
    .where(eq(dexterPlans.id, planId))
    .returning();
  return updated!;
}

export async function invokeDexterPlan(db: Db, workspaceId: string, planId: string, userId?: string) {
  const [plan] = await db
    .select()
    .from(dexterPlans)
    .where(and(eq(dexterPlans.id, planId), eq(dexterPlans.workspaceId, workspaceId)))
    .limit(1);
  if (!plan) throw new HttpError("Dexter plan not found", 404);
  if (plan.status !== "approved") {
    throw new HttpError("Dexter plan must be approved before invoke", 422);
  }

  const policy = await assertAllowed(db, {
    workspaceId,
    actionKey: "dexter.plan_invoke",
    actorUserId: userId,
    entityType: "dexter_plan",
    entityId: planId,
    priorApproval: true,
    detail: { phase: "invoke" },
  });

  const outcome = {
    invoked: true,
    at: new Date().toISOString(),
    learningHint: "threshold_unchanged",
  };

  const [updated] = await db
    .update(dexterPlans)
    .set({ status: "invoked", invokedAt: new Date(), outcome, policyDecisionId: policy.decisionId })
    .where(eq(dexterPlans.id, planId))
    .returning();

  incrJourneyMetric("dexterPlanInvoke");
  return { plan: updated!, policy };
}

export async function recordDexterLearning(
  db: Db,
  workspaceId: string,
  planId: string,
  learning: Record<string, unknown>
) {
  const [plan] = await db
    .select()
    .from(dexterPlans)
    .where(and(eq(dexterPlans.id, planId), eq(dexterPlans.workspaceId, workspaceId)))
    .limit(1);
  if (!plan) throw new HttpError("Dexter plan not found", 404);

  const outcome = { ...(typeof plan.outcome === "object" && plan.outcome ? plan.outcome : {}), learning };
  const [updated] = await db
    .update(dexterPlans)
    .set({ status: "learned", outcome })
    .where(eq(dexterPlans.id, planId))
    .returning();
  return updated!;
}
