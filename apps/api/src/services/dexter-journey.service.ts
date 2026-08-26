import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { HttpError } from "../utils/http.js";
import { classifyAndRecord, assertAllowed } from "./policy-gateway.service.js";
import { incrJourneyMetric } from "./journey-metrics.js";
import { pinAiClaim } from "./ai-evidence.service.js";

const { dexterPlans, linkedinVoiceHandoffs, activities } = schema;

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

export async function createLinkedinVoiceHandoff(
  db: Db,
  opts: {
    workspaceId: string;
    prospectId: string;
    scriptText: string;
    voiceChoice?: string;
    regionalBriefPreview?: string;
    userId?: string;
  }
) {
  let evidenceId: string | undefined;
  try {
    const pinned = await pinAiClaim(db, {
      workspaceId: opts.workspaceId,
      entityType: "prospect",
      entityId: opts.prospectId,
      attribute: "linkedin_voice_script",
      value: { scriptPreview: opts.scriptText.slice(0, 500), voiceChoice: opts.voiceChoice ?? "self" },
      source: "linkedin_voice",
      method: "linkedin_voice_script",
      versionName: "personalize",
    });
    evidenceId = pinned.evidenceId;
  } catch {
    // Pin failure must not block handoff preview.
  }

  const token = randomUUID();
  const [row] = await db
    .insert(linkedinVoiceHandoffs)
    .values({
      workspaceId: opts.workspaceId,
      prospectId: opts.prospectId,
      scriptText: opts.scriptText,
      voiceChoice: opts.voiceChoice ?? "self",
      regionalBriefPreview: opts.regionalBriefPreview,
      evidenceId,
      status: "handed_off",
      handoffToken: token,
      createdBy: opts.userId,
    })
    .returning();

  return row!;
}

export async function confirmLinkedinVoiceSent(
  db: Db,
  opts: { workspaceId: string; handoffToken: string; userId?: string }
) {
  const [handoff] = await db
    .select()
    .from(linkedinVoiceHandoffs)
    .where(
      and(
        eq(linkedinVoiceHandoffs.handoffToken, opts.handoffToken),
        eq(linkedinVoiceHandoffs.workspaceId, opts.workspaceId)
      )
    )
    .limit(1);
  if (!handoff) throw new HttpError("Handoff not found", 404);
  if (handoff.status === "confirmed") return handoff;

  await assertAllowed(db, {
    workspaceId: opts.workspaceId,
    actionKey: "linkedin.voice_confirm",
    actorUserId: opts.userId,
    entityType: "linkedin_voice_handoff",
    entityId: handoff.id,
    priorApproval: true,
  });

  // Timeline activity (CRM shared table) — manual confirm only, never background send.
  try {
    await db.insert(activities).values({
      workspaceId: opts.workspaceId,
      entityType: "prospect",
      entityId: randomUUID(),
      activityType: "linkedin_voice_sent",
      subject: "LinkedIn voice message confirmed",
      body: `${handoff.scriptText.slice(0, 1800)}\n\nprospectId=${handoff.prospectId};handoffId=${handoff.id}`,
      ownerId: opts.userId,
      occurredAt: new Date(),
    });
  } catch {
    // activities insert is best-effort for timeline capture.
  }

  const [updated] = await db
    .update(linkedinVoiceHandoffs)
    .set({ status: "confirmed", confirmedAt: new Date() })
    .where(eq(linkedinVoiceHandoffs.id, handoff.id))
    .returning();

  incrJourneyMetric("linkedinVoiceConfirm");
  return updated!;
}
