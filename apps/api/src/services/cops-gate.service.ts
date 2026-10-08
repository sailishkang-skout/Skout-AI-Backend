import { and, eq, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";

/**
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md (COPS-03 additions).
 *   - Tables touched directly: deals - write of deals.deal_type only, when the gate policy changes (owned by apps/crm)
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: the deal type selects the gate policy, so it changes in the same transaction as the gate
 *     lock, the audit row and the outbox event. An HTTP call into apps/crm cannot take part in it.
 *   - Review date: revisit when apps/crm's internal API covers transactional writes
 */
import {
  appendCopsEvent,
  COMMERCIAL_GATE_POLICIES,
  createCopsEvent,
  isGateOpen,
  SYSTEM_DEFAULT_GATE_POLICY,
  type CommercialGatePolicy,
  type GateConditions,
} from "@skout/shared";
import { writeCopsAudit } from "./cops-platform.service.js";
import { advanceCommercialState, CommercialError, getOpportunity, type CommercialContext } from "./cops-commercial.service.js";

const { commercialGates, commercialGatePolicies, contracts, paymentRequests, deals } = schema;

/** "*" is the workspace default policy row. */
export const DEFAULT_DEAL_TYPE = "*";

export type GateTrigger = "signature" | "payment" | "trial_approval" | "override" | "policy_change";
type Actor = { type: "user" | "integration"; id: string | null };

export async function resolveGatePolicy(
  db: Db,
  workspaceId: string,
  dealType: string | null
): Promise<{ policy: CommercialGatePolicy; source: "deal_type" | "workspace_default" | "system_default" }> {
  const keys = dealType ? [dealType, DEFAULT_DEAL_TYPE] : [DEFAULT_DEAL_TYPE];
  const rows = await db
    .select({ dealType: commercialGatePolicies.dealType, policy: commercialGatePolicies.policy })
    .from(commercialGatePolicies)
    .where(and(eq(commercialGatePolicies.workspaceId, workspaceId), inArray(commercialGatePolicies.dealType, keys)));
  const specific = dealType ? rows.find((r) => r.dealType === dealType) : undefined;
  if (specific) return { policy: specific.policy as CommercialGatePolicy, source: "deal_type" };
  const fallback = rows.find((r) => r.dealType === DEFAULT_DEAL_TYPE);
  if (fallback) return { policy: fallback.policy as CommercialGatePolicy, source: "workspace_default" };
  return { policy: SYSTEM_DEFAULT_GATE_POLICY, source: "system_default" };
}

type GateRow = typeof commercialGates.$inferSelect;

/** Conditions are derived from the records themselves, so there is no second copy to drift. */
async function conditionsFor(db: Db, workspaceId: string, opportunityId: string, gate: GateRow | undefined): Promise<GateConditions> {
  const [signed] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(contracts)
    .where(
      and(
        eq(contracts.workspaceId, workspaceId),
        eq(contracts.opportunityId, opportunityId),
        eq(contracts.status, "signed"),
        // A DPA alone is not the commercial signature; the MSA or order form is.
        inArray(contracts.kind, ["msa", "order_form"])
      )
    );
  const [paid] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(paymentRequests)
    .where(
      and(
        eq(paymentRequests.workspaceId, workspaceId),
        eq(paymentRequests.opportunityId, opportunityId),
        eq(paymentRequests.status, "paid")
      )
    );
  return {
    trial_approved: Boolean(gate?.trialApprovedAt),
    signature_complete: (signed?.n ?? 0) > 0,
    payment_complete: (paid?.n ?? 0) > 0,
    overridden: Boolean(gate?.overrideAt),
  };
}

async function lockGate(tx: Db, workspaceId: string, opportunityId: string): Promise<GateRow> {
  await tx.insert(commercialGates).values({ workspaceId, opportunityId }).onConflictDoNothing();
  const [gate] = await tx
    .select()
    .from(commercialGates)
    .where(and(eq(commercialGates.opportunityId, opportunityId), eq(commercialGates.workspaceId, workspaceId)))
    .for("update")
    .limit(1);
  if (!gate) throw new Error("Gate row missing after initialization");
  return gate;
}

/**
 * Evaluate the gate inside the caller's transaction. The gate row is locked first, so concurrent
 * evaluations run one after the other and each reads the other's committed changes. fired_at is set
 * once and ProvisioningRequested is appended in the same transaction: exactly one event per
 * opportunity, never retracted (a later failed payment or refund does not un-fire it).
 */
export async function evaluateGate(
  tx: Db,
  input: { workspaceId: string; opportunityId: string; trigger: GateTrigger; actor: Actor; requestId: string }
): Promise<{ fired: boolean; alreadyFired: boolean }> {
  const gate = await lockGate(tx, input.workspaceId, input.opportunityId);
  if (gate.firedAt) return { fired: false, alreadyFired: true };
  const opportunity = await getOpportunity(tx, input.workspaceId, input.opportunityId);
  const { policy } = await resolveGatePolicy(tx, input.workspaceId, opportunity.dealType);
  const conditions = await conditionsFor(tx, input.workspaceId, input.opportunityId, gate);
  if (!isGateOpen(policy, conditions)) return { fired: false, alreadyFired: false };

  const at = new Date();
  const event = createCopsEvent({
    eventType: "ProvisioningRequested",
    tenantId: input.workspaceId,
    aggregateType: "opportunity",
    aggregateId: input.opportunityId,
    actor: input.actor,
    correlationId: input.requestId,
    payload: { opportunity_id: input.opportunityId, account_id: opportunity.companyId, policy, trigger: input.trigger },
    occurredAt: at,
  });
  const updated = await tx
    .update(commercialGates)
    .set({ firedAt: at, firedEventId: event.event_id, firedPolicy: policy, updatedAt: at })
    .where(and(eq(commercialGates.opportunityId, input.opportunityId), sql`${commercialGates.firedAt} is null`))
    .returning({ opportunityId: commercialGates.opportunityId });
  if (updated.length === 0) return { fired: false, alreadyFired: true };
  await appendCopsEvent(tx as never, event);
  await writeCopsAudit(tx, {
    tenantId: input.workspaceId,
    actor: input.actor,
    entityType: "commercial_gate",
    entityId: input.opportunityId,
    action: "gate.fired",
    after: { policy, trigger: input.trigger, conditions, event_id: event.event_id },
    correlationId: input.requestId,
    sourceChannel: input.actor.type === "integration" ? "webhook" : "api",
    occurredAt: at,
  });
  await advanceCommercialState(tx, {
    workspaceId: input.workspaceId,
    opportunityId: input.opportunityId,
    to: "complete",
    actorId: input.actor.id,
    actorType: input.actor.type,
    reason: `Commercial gate (${policy}) satisfied`,
    requestId: input.requestId,
  });
  return { fired: true, alreadyFired: false };
}

export async function getGate(db: Db, workspaceId: string, opportunityId: string) {
  const opportunity = await getOpportunity(db, workspaceId, opportunityId);
  const [gate] = await db
    .select()
    .from(commercialGates)
    .where(and(eq(commercialGates.opportunityId, opportunityId), eq(commercialGates.workspaceId, workspaceId)))
    .limit(1);
  const resolved = await resolveGatePolicy(db, workspaceId, opportunity.dealType);
  // Once fired, report the policy that fired it, even if the deal type or policy changed since.
  const policy = (gate?.firedPolicy as CommercialGatePolicy | null) ?? resolved.policy;
  const conditions = await conditionsFor(db, workspaceId, opportunityId, gate);
  return {
    opportunity_id: opportunityId,
    deal_type: opportunity.dealType,
    policy,
    policy_source: resolved.source,
    conditions,
    open: Boolean(gate?.firedAt) || isGateOpen(policy, conditions),
    fired_at: gate?.firedAt?.toISOString() ?? null,
    trial_approved_at: gate?.trialApprovedAt?.toISOString() ?? null,
    override: gate?.overrideAt
      ? { by: gate.overrideBy, reason: gate.overrideReason, at: gate.overrideAt.toISOString() }
      : null,
  };
}

/** Trial approval satisfies trial_approval_only. Idempotent: a second approval changes nothing. */
export async function approveTrial(db: Db, ctx: CommercialContext, opportunityId: string, reason: string) {
  await getOpportunity(db, ctx.workspaceId, opportunityId);
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const gate = await lockGate(tx, ctx.workspaceId, opportunityId);
    if (!gate.trialApprovedAt) {
      const at = new Date();
      await tx
        .update(commercialGates)
        .set({ trialApprovedAt: at, trialApprovedBy: ctx.userId, updatedAt: at })
        .where(eq(commercialGates.opportunityId, opportunityId));
      await writeCopsAudit(tx, {
        tenantId: ctx.workspaceId,
        actor: { type: "user", id: ctx.userId },
        entityType: "commercial_gate",
        entityId: opportunityId,
        action: "gate.trial_approved",
        after: { trial_approved_at: at.toISOString() },
        reason,
        correlationId: ctx.requestId,
        sourceChannel: "api",
        occurredAt: at,
      });
    }
    return evaluateGate(tx, {
      workspaceId: ctx.workspaceId,
      opportunityId,
      trigger: "trial_approval",
      actor: { type: "user", id: ctx.userId },
      requestId: ctx.requestId,
    });
  });
}

/** Manual override: opens the gate whatever the policy. Reason required; audited as an override. */
export async function overrideGate(db: Db, ctx: CommercialContext, opportunityId: string, reason: string) {
  await getOpportunity(db, ctx.workspaceId, opportunityId);
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const gate = await lockGate(tx, ctx.workspaceId, opportunityId);
    if (gate.firedAt) {
      throw new CommercialError("BUSINESS_STATE_CONFLICT", "The gate already fired; provisioning was already requested", {
        fired_at: gate.firedAt.toISOString(),
      });
    }
    const at = new Date();
    await tx
      .update(commercialGates)
      .set({ overrideAt: at, overrideBy: ctx.userId, overrideReason: reason, updatedAt: at })
      .where(eq(commercialGates.opportunityId, opportunityId));
    await writeCopsAudit(tx, {
      tenantId: ctx.workspaceId,
      actor: { type: "user", id: ctx.userId },
      entityType: "commercial_gate",
      entityId: opportunityId,
      action: "gate.overridden",
      before: { override: false },
      after: { override: true },
      reason,
      override: true,
      correlationId: ctx.requestId,
      sourceChannel: "api",
      occurredAt: at,
    });
    return evaluateGate(tx, {
      workspaceId: ctx.workspaceId,
      opportunityId,
      trigger: "override",
      actor: { type: "user", id: ctx.userId },
      requestId: ctx.requestId,
    });
  });
}

export async function listGatePolicies(db: Db, workspaceId: string) {
  const rows = await db.select().from(commercialGatePolicies).where(eq(commercialGatePolicies.workspaceId, workspaceId));
  return rows.map((r) => ({ deal_type: r.dealType, policy: r.policy, updated_at: r.updatedAt.toISOString() }));
}

/** Set the policy for one deal type. Opportunities that already fired keep their result. */
export async function setGatePolicy(db: Db, ctx: CommercialContext, dealType: string, policy: CommercialGatePolicy) {
  if (!(COMMERCIAL_GATE_POLICIES as readonly string[]).includes(policy)) {
    throw new CommercialError("VALIDATION_FAILED", "Unknown policy", { fields: [{ path: "policy", code: "invalid", message: "Unknown policy" }] });
  }
  await db.transaction(async (tx) => {
    const [before] = await tx
      .select({ policy: commercialGatePolicies.policy })
      .from(commercialGatePolicies)
      .where(and(eq(commercialGatePolicies.workspaceId, ctx.workspaceId), eq(commercialGatePolicies.dealType, dealType)))
      .limit(1);
    const at = new Date();
    await tx
      .insert(commercialGatePolicies)
      .values({ workspaceId: ctx.workspaceId, dealType, policy, updatedBy: ctx.userId, updatedAt: at })
      .onConflictDoUpdate({
        target: [commercialGatePolicies.workspaceId, commercialGatePolicies.dealType],
        set: { policy, updatedBy: ctx.userId, updatedAt: at },
      });
    await writeCopsAudit(tx, {
      tenantId: ctx.workspaceId,
      actor: { type: "user", id: ctx.userId },
      // The policy belongs to the workspace; the deal type is in before/after.
      entityType: "commercial_gate_policy",
      entityId: ctx.workspaceId,
      action: "gate_policy.set",
      before: { deal_type: dealType, policy: before?.policy ?? null },
      after: { deal_type: dealType, policy },
      correlationId: ctx.requestId,
      sourceChannel: "api",
      occurredAt: at,
    });
  });
}

/** Set an opportunity's deal type (selects its policy) and re-evaluate. Not allowed after firing. */
export async function setDealType(db: Db, ctx: CommercialContext, opportunityId: string, dealType: string) {
  const opportunity = await getOpportunity(db, ctx.workspaceId, opportunityId);
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const gate = await lockGate(tx, ctx.workspaceId, opportunityId);
    if (gate.firedAt) {
      throw new CommercialError("BUSINESS_STATE_CONFLICT", "The gate already fired; the deal type can no longer change the policy", {
        fired_at: gate.firedAt.toISOString(),
      });
    }
    await tx.update(deals).set({ dealType, updatedAt: new Date() }).where(eq(deals.id, opportunityId));
    await writeCopsAudit(tx, {
      tenantId: ctx.workspaceId,
      actor: { type: "user", id: ctx.userId },
      entityType: "opportunity",
      entityId: opportunityId,
      action: "opportunity.deal_type_set",
      before: { deal_type: opportunity.dealType },
      after: { deal_type: dealType },
      correlationId: ctx.requestId,
      sourceChannel: "api",
    });
    return evaluateGate(tx, {
      workspaceId: ctx.workspaceId,
      opportunityId,
      trigger: "policy_change",
      actor: { type: "user", id: ctx.userId },
      requestId: ctx.requestId,
    });
  });
}
