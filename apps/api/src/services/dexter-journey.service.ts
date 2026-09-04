import { and, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedById } from "@skout/db";
import type { Env } from "../config/env.js";
import { HttpError } from "../utils/http.js";
import { classifyAndRecord, assertAllowed } from "./policy-gateway.service.js";
import { incrJourneyMetric } from "./journey-metrics.js";
import { buildSequenceService } from "./sequence.service.js";
import { emitSkoutEvent } from "./skout-event.service.js";
import { captureFeedback } from "./intelligence-layer.service.js";
import { startWorkflowRun } from "./decision-workflow.service.js";

export {
  checkLinkedinVoiceEligibility,
  confirmLinkedinVoiceSent,
  createLinkedinVoiceHandoff,
  draftLinkedinVoiceScript,
  getLinkedinVoiceHandoff,
  listLinkedinVoiceHandoffs,
  synthesizeVoiceAudio,
} from "./linkedin-voice.service.js";

const { dexterPlans, sequences } = schema;

export async function proposeDexterPlan(
  db: Db,
  config: Env,
  opts: {
    workspaceId: string;
    brief: string;
    userId?: string;
    actionType?: string;
    actionParams?: Record<string, unknown>;
  }
) {
  const classify = await classifyAndRecord(db, {
    workspaceId: opts.workspaceId,
    actionKey: "dexter.plan_invoke",
    actorUserId: opts.userId,
    detail: { phase: "propose" },
  });

  const proposal: Record<string, unknown> = {
    steps: [
      { id: "brief_approval", status: "pending", label: "Review plan brief" },
      { id: "policy_gateway_classify", status: "done", mode: classify.mode, label: "Policy classification" },
      { id: "post_approval_invoke", status: "blocked_until_approve", label: "Execute after approval" },
      { id: "outcome_hypothesis_attribution", status: "pending", label: "Attribute outcomes" },
      { id: "learning_update_threshold", status: "pending", label: "Update learning thresholds" },
    ],
    hypothesis: `Executing brief: ${opts.brief.slice(0, 200)}`,
    scope: "Workspace GTM actions governed by Policy Gateway",
    creditCost: 0,
    externalSideEffects: ["May enroll contacts or activate sequences after invoke"],
  };
  if (opts.actionType) proposal.actionType = opts.actionType;
  if (opts.actionParams) proposal.actionParams = opts.actionParams;

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

  const event =
    classify.outcome === "denied"
      ? await emitSkoutEvent(db, config, {
          type: "dexter.plan.blocked",
          tenantId: opts.workspaceId,
          aggregateId: plan!.id,
          data: {
            planId: plan!.id,
            brief: opts.brief,
            policyMode: classify.mode,
            actionType: opts.actionType ?? null,
          },
        })
      : await emitSkoutEvent(db, config, {
          type: "dexter.plan.proposed",
          tenantId: opts.workspaceId,
          aggregateId: plan!.id,
          data: {
            planId: plan!.id,
            brief: opts.brief,
            policyMode: classify.mode,
            actionType: opts.actionType ?? null,
          },
        });

  return { plan: plan!, policy: classify, correlationId: event.correlationId };
}

export async function approveDexterPlan(db: Db, config: Env, workspaceId: string, planId: string) {
  const [plan] = await db
    .select()
    .from(dexterPlans)
    .where(scopedById(dexterPlans, workspaceId, planId))
    .limit(1);
  if (!plan) throw new HttpError("Dexter plan not found", 404);
  if (plan.status !== "proposed") throw new HttpError(`Plan status is ${plan.status}`, 422);

  const [updated] = await db
    .update(dexterPlans)
    .set({ status: "approved", approvedAt: new Date() })
    .where(eq(dexterPlans.id, planId))
    .returning();

  await emitSkoutEvent(db, config, {
    type: "dexter.plan.approved",
    tenantId: workspaceId,
    aggregateId: planId,
    data: { planId, brief: plan.brief },
  });

  return updated!;
}

/** §7.3 Evaluation Loop — the "overridden" half of accepted-vs-overridden: a human explicitly
 * declining a proposed plan instead of approving it. Mirrors approveDexterPlan's guard shape. */
export async function rejectDexterPlan(
  db: Db,
  config: Env,
  workspaceId: string,
  planId: string,
  userId?: string,
  reason?: string
) {
  const [plan] = await db
    .select()
    .from(dexterPlans)
    .where(scopedById(dexterPlans, workspaceId, planId))
    .limit(1);
  if (!plan) throw new HttpError("Dexter plan not found", 404);
  if (plan.status !== "proposed") throw new HttpError(`Plan status is ${plan.status}`, 422);

  const [updated] = await db
    .update(dexterPlans)
    .set({ status: "rejected", rejectedAt: new Date(), rejectedBy: userId })
    .where(eq(dexterPlans.id, planId))
    .returning();

  await emitSkoutEvent(db, config, {
    type: "dexter.plan.rejected",
    tenantId: workspaceId,
    aggregateId: planId,
    data: { planId, brief: plan.brief, reason: reason ?? null },
  });

  return updated!;
}

export async function invokeDexterPlan(
  db: Db,
  config: Env,
  workspaceId: string,
  planId: string,
  userId?: string,
  opts?: { sequenceId?: string }
) {
  const [plan] = await db
    .select()
    .from(dexterPlans)
    .where(scopedById(dexterPlans, workspaceId, planId))
    .limit(1);
  if (!plan) throw new HttpError("Dexter plan not found", 404);
  if (plan.status !== "approved") {
    throw new HttpError("Dexter plan must be approved before invoke", 422);
  }

  if (opts?.sequenceId) {
    const [targetSequence] = await db
      .select({ id: sequences.id })
      .from(sequences)
      .where(and(eq(sequences.id, opts.sequenceId), eq(sequences.workspaceId, workspaceId)))
      .limit(1);
    if (!targetSequence) throw new HttpError("sequence_not_found", 404);
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

  const proposal = (plan.proposal ?? {}) as Record<string, unknown> & {
    steps?: Array<{ id: string; status?: string; label?: string }>;
  };
  const actionType = typeof proposal.actionType === "string" ? proposal.actionType : undefined;

  if (actionType === "enroll_sequence") {
    const actionParams = (proposal.actionParams ?? {}) as { sequenceId?: string; listId?: string };
    try {
      const seqSvc = buildSequenceService(db);
      const result = await seqSvc!.enroll(actionParams.sequenceId!, workspaceId, { listId: actionParams.listId });
      const outcome = { ...result, at: new Date().toISOString() };
      const [updated] = await db
        .update(dexterPlans)
        .set({ status: "invoked", invokedAt: new Date(), outcome, policyDecisionId: policy.decisionId })
        .where(eq(dexterPlans.id, planId))
        .returning();
      incrJourneyMetric("dexterPlanInvoke");

      await emitSkoutEvent(db, config, {
        type: "dexter.action.executed",
        tenantId: workspaceId,
        aggregateId: planId,
        correlationId: planId,
        data: { planId, actionType, outcome },
      });

      return { plan: updated!, policy };
    } catch (err) {
      const outcome = { error: err instanceof Error ? err.message : String(err), at: new Date().toISOString() };
      const [updated] = await db
        .update(dexterPlans)
        .set({ status: "failed", outcome, policyDecisionId: policy.decisionId })
        .where(eq(dexterPlans.id, planId))
        .returning();

      await emitSkoutEvent(db, config, {
        type: "dexter.action.failed",
        tenantId: workspaceId,
        aggregateId: planId,
        correlationId: planId,
        data: { planId, actionType, error: outcome.error },
      });

      return { plan: updated!, policy };
    }
  }

  if (actionType !== undefined) {
    // actionType is present but isn't a recognized/implemented action — fail closed
    // rather than silently reporting success for work that never ran. Only the
    // brief-only path (actionType absent entirely) is allowed to fall through to the
    // workflow-run stub below.
    const outcome = { error: `unsupported_action_type: ${actionType}`, at: new Date().toISOString() };
    const [updated] = await db
      .update(dexterPlans)
      .set({ status: "failed", outcome, policyDecisionId: policy.decisionId })
      .where(eq(dexterPlans.id, planId))
      .returning();

    await emitSkoutEvent(db, config, {
      type: "dexter.action.failed",
      tenantId: workspaceId,
      aggregateId: planId,
      correlationId: planId,
      data: { planId, actionType, error: outcome.error },
    });

    return { plan: updated!, policy };
  }

  const workflow = await startWorkflowRun(db, {
    workspaceId,
    name: `Dexter plan: ${plan.brief.slice(0, 80)}`,
    steps: (proposal.steps ?? []).map((s) => ({ name: s.label ?? s.id, status: s.status ?? "pending" })),
    correlationId: planId,
    userId,
  });

  const outcome = {
    invoked: true,
    at: new Date().toISOString(),
    workflowRunId: workflow.id,
    learningHint: "threshold_unchanged",
  };

  const [updated] = await db
    .update(dexterPlans)
    .set({ status: "invoked", invokedAt: new Date(), outcome, policyDecisionId: policy.decisionId })
    .where(eq(dexterPlans.id, planId))
    .returning();

  if (opts?.sequenceId) {
    await db.update(sequences).set({ dexterPlanId: planId }).where(eq(sequences.id, opts.sequenceId));
  }

  await emitSkoutEvent(db, config, {
    type: "dexter.action.executed",
    tenantId: workspaceId,
    aggregateId: planId,
    correlationId: planId,
    data: { planId, workflowRunId: workflow.id, brief: plan.brief },
  });

  incrJourneyMetric("dexterPlanInvoke");
  return { plan: updated!, policy, workflowRun: workflow };
}

export async function recordDexterLearning(
  db: Db,
  config: Env,
  workspaceId: string,
  planId: string,
  learning: Record<string, unknown>
) {
  const [plan] = await db
    .select()
    .from(dexterPlans)
    .where(scopedById(dexterPlans, workspaceId, planId))
    .limit(1);
  if (!plan) throw new HttpError("Dexter plan not found", 404);

  const feedback = captureFeedback({
    recommendationId: planId,
    outcome: "accepted",
    attribution: typeof learning.attribution === "string" ? learning.attribution : "dexter_plan",
    thresholdDelta: typeof learning.thresholdDelta === "number" ? learning.thresholdDelta : 0,
    sampleSize: typeof learning.sampleSize === "number" ? learning.sampleSize : 0,
  });

  const outcome = {
    ...(typeof plan.outcome === "object" && plan.outcome ? plan.outcome : {}),
    learning,
    feedback,
  };
  const [updated] = await db
    .update(dexterPlans)
    .set({ status: "learned", outcome })
    .where(eq(dexterPlans.id, planId))
    .returning();

  await emitSkoutEvent(db, config, {
    type: "dexter.learning.approved",
    tenantId: workspaceId,
    aggregateId: planId,
    correlationId: planId,
    data: { planId, learning: feedback },
  });

  await emitSkoutEvent(db, config, {
    type: "dexter.outcome.captured",
    tenantId: workspaceId,
    aggregateId: planId,
    correlationId: planId,
    data: { planId, outcome: feedback },
  });

  return updated!;
}
