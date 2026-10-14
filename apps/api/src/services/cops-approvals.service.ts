import { and, desc, eq, inArray, lt, notInArray, or, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import {
  APPROVER_DECIDED_BY,
  appendCopsEvent,
  approvalPolicySchema,
  createCopsEvent,
  canonicalJson,
  CopsIllegalTransitionError,
  COPS_TRANSITIONS,
  evaluateApprovals,
  materialChanges,
  proposalTcv,
  sha256Hex,
  type ApprovalEvaluation,
  type ApproverRole,
  type MaterialTerms,
} from "@skout/shared";
import { writeCopsAudit } from "./cops-platform.service.js";
import { getConfig } from "./cops-admin-config.service.js";
import { CommercialError, storedApprovalTerms, type CommercialContext } from "./cops-commercial.service.js";
import { evaluateGate } from "./cops-gate.service.js";

/**
 * COPS-08 approval engine (Bible p.34). A proposal version over a threshold needs every approver
 * its matching rules name. Thresholds come from the approval_policy admin config. An approval
 * belongs to the terms it was given for: a material change voids it, and it lapses after the
 * configured number of days. Deals under every threshold never get an approval row.
 */
const { proposals, proposalVersions, proposalLineItems, contracts, commercialGates, approvals, approvalDecisions, workspaceMemberRoles, roles } = schema;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Reader = Pick<Db, "select">;
type VersionRow = typeof proposalVersions.$inferSelect;
type LineRow = typeof proposalLineItems.$inferSelect;
type ApprovalRow = typeof approvals.$inferSelect;
type DecisionRow = typeof approvalDecisions.$inferSelect;

/** An approval that still counts: waiting for decisions, or granted. */
const OPEN_STATUSES = ["pending", "approved"];
/** Role keys that may decide the executive slot. */
const ADMIN_ROLE_KEYS = ["admin", "owner"];

/**
 * The terms the rules read, from a stored version. Contract value is TCV (see proposalTcv): every
 * line brought to the full term, after discount, before tax. The discount is the effective one on
 * that basis, line and header discounts together, so a discount cannot be hidden in line items.
 */
export function approvalTermsOf(version: VersionRow, lines: LineRow[]): MaterialTerms {
  const tcv = proposalTcv({
    term_months: version.termMonths,
    discount_pct: Number(version.discountPct),
    lines: lines.map((l) => ({ kind: l.kind, price_basis: l.priceBasis, gross_minor: Number(l.grossMinor), net_minor: Number(l.netMinor) })),
  });
  return {
    currency: version.currency,
    discount_pct: tcv.discount_pct,
    seats: lines.filter((l) => l.kind === "seats").reduce((sum, l) => sum + l.quantity, 0),
    contract_value_minor: tcv.tcv_minor,
    term_months: version.termMonths,
    ...storedApprovalTerms(version),
    billing_cadence: version.billingCadence,
    line_items_key: sha256Hex(
      canonicalJson(
        [...lines]
          .sort((a, b) => a.position - b.position)
          .map((l) => ({ kind: l.kind, basis: l.priceBasis, description: l.description, quantity: l.quantity, unit_amount_minor: Number(l.unitAmountMinor), discount_pct: Number(l.discountPct) }))
      )
    ),
  };
}

async function loadCurrent(db: Reader, workspaceId: string, proposalId: string) {
  const [proposal] = await db
    .select()
    .from(proposals)
    .where(and(eq(proposals.id, proposalId), eq(proposals.workspaceId, workspaceId)))
    .limit(1);
  if (!proposal) throw new CommercialError("NOT_FOUND", "Proposal not found");
  const [version] = await db
    .select()
    .from(proposalVersions)
    .where(and(eq(proposalVersions.proposalId, proposalId), eq(proposalVersions.version, proposal.currentVersion)))
    .limit(1);
  if (!version) throw new CommercialError("NOT_FOUND", "Proposal version not found");
  const lines = await db.select().from(proposalLineItems).where(eq(proposalLineItems.versionId, version.id));
  return { proposal, version, terms: approvalTermsOf(version, lines) };
}

/**
 * Deals that were already sent, signed or paid when the approval engine arrived are skipped by it
 * (migration 0126). Blocking a customer who has signed or paid is worse than a missed approval.
 */
async function isGrandfathered(db: Reader, workspaceId: string, opportunityId: string): Promise<boolean> {
  const [gate] = await db
    .select({ at: commercialGates.approvalsGrandfatheredAt })
    .from(commercialGates)
    .where(and(eq(commercialGates.opportunityId, opportunityId), eq(commercialGates.workspaceId, workspaceId)))
    .limit(1);
  return Boolean(gate?.at);
}

async function loadPolicy(db: Db, workspaceId: string) {
  const config = await getConfig(db, workspaceId, "approval_policy", "default");
  const parsed = approvalPolicySchema.safeParse(config?.value);
  if (!parsed.success) throw new CommercialError("BUSINESS_STATE_CONFLICT", "The approval policy is not configured", { config: "approval_policy" });
  return { policy: parsed.data, policyVersion: config?.is_system_default ? 0 : (config?.version ?? 0) };
}

function approvalDto(row: ApprovalRow, decisions: DecisionRow[]) {
  return {
    id: row.id,
    opportunity_id: row.opportunityId,
    proposal_id: row.proposalId,
    proposal_version: row.proposalVersion,
    status: row.status,
    required_approvers: row.requiredApprovers as ApproverRole[],
    matched_rules: row.matchedRules as ApprovalEvaluation["matched_rules"],
    terms: row.terms as MaterialTerms,
    policy_version: row.policyVersion,
    requested_by: row.requestedBy,
    requested_at: row.requestedAt.toISOString(),
    expires_at: row.expiresAt.toISOString(),
    status_reason: row.statusReason,
    resolved_at: row.resolvedAt?.toISOString() ?? null,
    decisions: decisions
      .filter((d) => d.approvalId === row.id)
      .map((d) => ({ role: d.approverRole as ApproverRole, decision: d.decision, decided_by: d.decidedBy, decided_at: d.decidedAt?.toISOString() ?? null, comment: d.comment })),
  };
}
export type ApprovalDto = ReturnType<typeof approvalDto>;

/**
 * Marks approvals past their expiry. Called before any read that depends on status. A granted
 * approval whose version was sent to the customer in time was used, and does not lapse afterwards.
 */
export async function expireDueApprovals(db: Pick<Db, "update">, workspaceId: string, now: Date = new Date()): Promise<number> {
  // Table-qualified by hand: inside the subquery a bare proposal_id would mean the version's own column.
  const versionWasSent = sql`exists (select 1 from proposal_versions v where v.proposal_id = "approvals"."proposal_id" and v.version = "approvals"."proposal_version" and v.sent_at is not null)`;
  const rows = await db
    .update(approvals)
    .set({ status: "expired", statusReason: "The approval period ended", resolvedAt: now })
    .where(
      and(
        eq(approvals.workspaceId, workspaceId),
        lt(approvals.expiresAt, now),
        or(eq(approvals.status, "pending"), and(eq(approvals.status, "approved"), sql`not ${versionWasSent}`))
      )
    )
    .returning({ id: approvals.id });
  return rows.length;
}

export async function listApprovals(db: Db, workspaceId: string, where: { proposalId?: string; status?: string; role?: ApproverRole; id?: string } = {}): Promise<ApprovalDto[]> {
  await expireDueApprovals(db, workspaceId);
  const rows = await db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.workspaceId, workspaceId),
        where.proposalId ? eq(approvals.proposalId, where.proposalId) : undefined,
        where.status ? eq(approvals.status, where.status) : undefined,
        where.id ? eq(approvals.id, where.id) : undefined
      )
    )
    .orderBy(desc(approvals.requestedAt))
    .limit(200);
  if (rows.length === 0) return [];
  const decisions = await db.select().from(approvalDecisions).where(inArray(approvalDecisions.approvalId, rows.map((r) => r.id)));
  const list = rows.map((r) => approvalDto(r, decisions));
  return where.role ? list.filter((a) => a.decisions.some((d) => d.role === where.role && d.decision === "pending")) : list;
}

/**
 * What the current version needs, and whether it has it. `satisfied` is true when nothing is
 * needed or an approval for exactly these terms is granted. Rules that cannot be evaluated (no
 * contract-value thresholds for the currency) are reported and do not block.
 */
export async function evaluateProposalApprovals(db: Db, workspaceId: string, proposalId: string) {
  const { proposal, terms } = await loadCurrent(db, workspaceId, proposalId);
  const { policy, policyVersion } = await loadPolicy(db, workspaceId);
  const evaluation = evaluateApprovals(policy, terms);
  const open = (await listApprovals(db, workspaceId, { proposalId })).find((a) => OPEN_STATUSES.includes(a.status) && a.proposal_version === proposal.currentVersion) ?? null;
  const grandfathered = await isGrandfathered(db, workspaceId, proposal.opportunityId);
  const required = !grandfathered && evaluation.required_approvers.length > 0;
  return {
    proposal_id: proposalId,
    proposal_version: proposal.currentVersion,
    currency: terms.currency,
    terms,
    ...evaluation,
    policy_version: policyVersion,
    /** True for a deal already in flight before COPS-08: the rules are shown but not enforced. */
    grandfathered,
    required,
    satisfied: !required || (open?.status === "approved" && evaluation.required_approvers.every((r) => open.required_approvers.includes(r))),
    approval: open,
  };
}

/** Throws 409 unless the current version needs no approval or has one. Used before a send and by the gate. */
export async function assertApproved(db: Db, workspaceId: string, proposalId: string): Promise<void> {
  const state = await evaluateProposalApprovals(db, workspaceId, proposalId);
  if (!state.satisfied) {
    throw new CommercialError("BUSINESS_STATE_CONFLICT", "This proposal needs approval before it can go out", {
      required_approvers: state.required_approvers,
      approval_status: state.approval?.status ?? "not_requested",
    });
  }
}

/**
 * Approval state of an opportunity, for the provisioning gate. Every proposal that is still live
 * (not declined or expired) must need no approval or have one. `blocking` names the ones that do not.
 */
export async function opportunityApprovals(db: Db, workspaceId: string, opportunityId: string) {
  const live = await db
    .select({ id: proposals.id })
    .from(proposals)
    .where(and(eq(proposals.workspaceId, workspaceId), eq(proposals.opportunityId, opportunityId), notInArray(proposals.status, ["declined", "expired"])));
  const blocking: Array<{ proposal_id: string; required_approvers: ApproverRole[]; approval_status: string }> = [];
  for (const { id } of live) {
    const state = await evaluateProposalApprovals(db, workspaceId, id);
    if (!state.satisfied) blocking.push({ proposal_id: id, required_approvers: state.required_approvers, approval_status: state.approval?.status ?? "not_requested" });
  }
  return { complete: blocking.length === 0, blocking };
}

/** A contract built from a proposal cannot go out for signature before that proposal is approved. */
export async function assertContractApproved(db: Db, workspaceId: string, contractId: string): Promise<void> {
  const [contract] = await db
    .select({ proposalId: contracts.proposalId })
    .from(contracts)
    .where(and(eq(contracts.id, contractId), eq(contracts.workspaceId, workspaceId)))
    .limit(1);
  if (contract?.proposalId) await assertApproved(db, workspaceId, contract.proposalId);
}

export async function requestApproval(db: Db, ctx: CommercialContext, proposalId: string): Promise<ApprovalDto> {
  const state = await evaluateProposalApprovals(db, ctx.workspaceId, proposalId);
  if (!state.required) {
    throw new CommercialError(
      "BUSINESS_STATE_CONFLICT",
      state.grandfathered ? "This deal was already in progress before approvals were introduced and needs none" : "This proposal is under every threshold and needs no approval",
      { required_approvers: [], grandfathered: state.grandfathered }
    );
  }
  if (state.approval) throw new CommercialError("BUSINESS_STATE_CONFLICT", `An approval for this version is already ${state.approval.status}`, { approval_id: state.approval.id });
  const { policy } = await loadPolicy(db, ctx.workspaceId);

  const id = await db.transaction(async (tx) => {
    // The lock makes two concurrent requests for one version take turns; the second sees the first.
    const [proposal] = await tx.select().from(proposals).where(eq(proposals.id, proposalId)).for("update").limit(1);
    if (!proposal || proposal.currentVersion !== state.proposal_version) {
      throw new CommercialError("BUSINESS_STATE_CONFLICT", "The proposal changed while approval was being requested; try again");
    }
    const [existing] = await tx
      .select({ id: approvals.id })
      .from(approvals)
      .where(and(eq(approvals.proposalId, proposalId), eq(approvals.proposalVersion, state.proposal_version), inArray(approvals.status, OPEN_STATUSES)))
      .limit(1);
    if (existing) throw new CommercialError("BUSINESS_STATE_CONFLICT", "An approval for this version already exists", { approval_id: existing.id });
    const now = new Date();
    const [row] = await tx
      .insert(approvals)
      .values({
        workspaceId: ctx.workspaceId,
        opportunityId: proposal.opportunityId,
        proposalId,
        proposalVersion: state.proposal_version,
        requiredApprovers: state.required_approvers,
        matchedRules: state.matched_rules,
        terms: state.terms,
        policyVersion: state.policy_version,
        requestedBy: ctx.userId,
        requestedAt: now,
        expiresAt: new Date(now.getTime() + policy.expires_after_days * 86_400_000),
      })
      .returning({ id: approvals.id });
    await tx.insert(approvalDecisions).values(state.required_approvers.map((role) => ({ workspaceId: ctx.workspaceId, approvalId: row!.id, approverRole: role })));
    await writeCopsAudit(tx, {
      tenantId: ctx.workspaceId,
      actor: { type: "user", id: ctx.userId },
      entityType: "approval",
      entityId: row!.id,
      action: "approval.requested",
      after: { proposal_id: proposalId, version: state.proposal_version, required_approvers: state.required_approvers, rules: state.matched_rules.map((m) => m.rule) },
      correlationId: ctx.requestId,
      sourceChannel: "api",
    });
    await emitApprovalEvent(
      tx,
      ctx,
      { id: row!.id, proposalId, opportunityId: proposal.opportunityId, proposalVersion: state.proposal_version },
      { type: "ApprovalRequested", required_approvers: state.required_approvers }
    );
    return row!.id;
  });
  return (await listApprovals(db, ctx.workspaceId, { id }))[0]!;
}

/** Outbox event in the caller's transaction; the event worker turns it into in-app notifications by role. */
async function emitApprovalEvent(
  tx: Tx,
  ctx: CommercialContext,
  approval: { id: string; proposalId: string; opportunityId: string; proposalVersion: number },
  event: { type: "ApprovalRequested"; required_approvers: ApproverRole[] } | { type: "ApprovalDecided"; status: "approved" | "rejected" | "voided"; reason: string | null }
): Promise<void> {
  const base = { approval_id: approval.id, proposal_id: approval.proposalId, opportunity_id: approval.opportunityId, proposal_version: approval.proposalVersion };
  await appendCopsEvent(
    tx as never,
    createCopsEvent({
      eventType: event.type,
      tenantId: ctx.workspaceId,
      aggregateType: "proposal",
      aggregateId: approval.proposalId,
      actor: { type: "user", id: ctx.userId },
      correlationId: ctx.requestId,
      payload: event.type === "ApprovalRequested" ? { ...base, required_approvers: event.required_approvers } : { ...base, status: event.status, reason: event.reason },
    })
  );
}

async function memberRoleKeys(db: Reader, workspaceId: string, userId: string): Promise<string[]> {
  const rows = await db
    .select({ key: roles.key })
    .from(workspaceMemberRoles)
    .innerJoin(roles, eq(roles.id, workspaceMemberRoles.roleId))
    .where(and(eq(workspaceMemberRoles.workspaceId, workspaceId), eq(workspaceMemberRoles.userId, userId)));
  return rows.map((r) => r.key);
}

/** True when the member may decide that approver slot. An Admin (or the owner) decides the executive slot. */
export function mayDecide(roleKeys: string[], slot: ApproverRole): boolean {
  const needed = APPROVER_DECIDED_BY[slot];
  return needed === "admin" ? roleKeys.some((k) => ADMIN_ROLE_KEYS.includes(k)) : roleKeys.includes(needed);
}

export async function decideApproval(
  db: Db,
  ctx: CommercialContext,
  approvalId: string,
  input: { role: ApproverRole; decision: "approved" | "rejected"; comment?: string | null }
): Promise<ApprovalDto> {
  const comment = input.comment?.trim() || null;
  if (input.decision === "rejected" && !comment) {
    throw new CommercialError("VALIDATION_FAILED", "A comment is required to reject", { fields: [{ path: "comment", code: "required", message: "A comment is required to reject" }] });
  }
  await expireDueApprovals(db, ctx.workspaceId);
  if (!mayDecide(await memberRoleKeys(db, ctx.workspaceId, ctx.userId), input.role)) {
    throw new CommercialError("FORBIDDEN", `Only ${APPROVER_DECIDED_BY[input.role] === "admin" ? "an Admin" : `the ${input.role} role`} can decide this approval`, { role: input.role });
  }

  await db.transaction(async (tx) => {
    const [approval] = await tx
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, approvalId), eq(approvals.workspaceId, ctx.workspaceId)))
      .for("update")
      .limit(1);
    if (!approval) throw new CommercialError("NOT_FOUND", "Approval not found");
    if (approval.status !== "pending") throw new CommercialError("BUSINESS_STATE_CONFLICT", `This approval is ${approval.status}`, { status: approval.status });
    const now = new Date();
    const [decided] = await tx
      .update(approvalDecisions)
      .set({ decision: input.decision, decidedBy: ctx.userId, decidedAt: now, comment })
      .where(and(eq(approvalDecisions.approvalId, approvalId), eq(approvalDecisions.approverRole, input.role), eq(approvalDecisions.decision, "pending")))
      .returning({ id: approvalDecisions.id });
    if (!decided) throw new CommercialError("BUSINESS_STATE_CONFLICT", `The ${input.role} decision is not pending on this approval`, { role: input.role });

    const all = await tx.select({ decision: approvalDecisions.decision }).from(approvalDecisions).where(eq(approvalDecisions.approvalId, approvalId));
    const status = input.decision === "rejected" ? "rejected" : all.every((d) => d.decision === "approved") ? "approved" : "pending";
    if (status !== "pending") {
      await tx
        .update(approvals)
        .set({ status, resolvedAt: now, statusReason: status === "rejected" ? `Rejected by ${input.role}` : null })
        .where(eq(approvals.id, approvalId));
    }
    await writeCopsAudit(tx, {
      tenantId: ctx.workspaceId,
      actor: { type: "user", id: ctx.userId },
      entityType: "approval",
      entityId: approvalId,
      action: `approval.${input.decision}`,
      before: { status: approval.status },
      after: { status, role: input.role, proposal_id: approval.proposalId, version: approval.proposalVersion },
      reason: comment ?? undefined,
      correlationId: ctx.requestId,
      sourceChannel: "api",
    });
    if (status !== "pending") await emitApprovalEvent(tx, ctx, approval, { type: "ApprovalDecided", status, reason: status === "rejected" ? comment : null });
    // The signature or payment may have arrived first; the last approval is then what opens the gate.
    if (status === "approved") {
      await evaluateGate(tx as unknown as Db, {
        workspaceId: ctx.workspaceId,
        opportunityId: approval.opportunityId,
        trigger: "approval",
        actor: { type: "user", id: ctx.userId },
        requestId: ctx.requestId,
      });
    }
  });
  return (await listApprovals(db, ctx.workspaceId, { id: approvalId }))[0]!;
}

/**
 * Called in the transaction that adds a proposal version. An open approval is voided when the new
 * version differs in a material term; otherwise (title or notes only) it moves to the new version.
 */
export async function carryOrVoidApprovals(tx: Tx, ctx: CommercialContext, proposalId: string): Promise<void> {
  const open = await tx
    .select()
    .from(approvals)
    .where(and(eq(approvals.proposalId, proposalId), eq(approvals.workspaceId, ctx.workspaceId), inArray(approvals.status, OPEN_STATUSES)))
    .for("update");
  if (open.length === 0) return;
  const { proposal, terms } = await loadCurrent(tx, ctx.workspaceId, proposalId);
  for (const approval of open) {
    const changed = materialChanges(approval.terms as MaterialTerms, terms);
    if (changed.length === 0) {
      await tx.update(approvals).set({ proposalVersion: proposal.currentVersion }).where(eq(approvals.id, approval.id));
      continue;
    }
    await tx
      .update(approvals)
      .set({ status: "voided", statusReason: `The terms changed: ${changed.join(", ")}`, resolvedAt: new Date() })
      .where(eq(approvals.id, approval.id));
    await writeCopsAudit(tx, {
      tenantId: ctx.workspaceId,
      actor: { type: "user", id: ctx.userId },
      entityType: "approval",
      entityId: approval.id,
      action: "approval.voided",
      before: { status: approval.status, version: approval.proposalVersion },
      after: { status: "voided", version: proposal.currentVersion, changed },
      correlationId: ctx.requestId,
      sourceChannel: "api",
    });
    await emitApprovalEvent(tx, ctx, approval, { type: "ApprovalDecided", status: "voided", reason: `The terms changed: ${changed.join(", ")}` });
  }
}

/**
 * The stage rule (Bible p.22, p.34): an opportunity cannot be moved to won while one of its live
 * proposals is over a threshold and unapproved. Thrown as the lifecycle's own illegal-transition
 * error, so the stage routes answer 409 BUSINESS_STATE_CONFLICT and the board shows the message
 * inline like any other stage rule. Call it in the transaction that makes the move.
 */
export async function assertApprovalsAllowWin(db: Db, workspaceId: string, opportunityId: string, from: string): Promise<void> {
  const state = await opportunityApprovals(db, workspaceId, opportunityId);
  if (state.complete) return;
  const waiting = [...new Set(state.blocking.flatMap((b) => b.required_approvers))];
  const allowed = (COPS_TRANSITIONS.opportunity as Record<string, readonly string[]>)[from]?.filter((s) => s !== "won") ?? [];
  const error = new CopsIllegalTransitionError("opportunity", from, "won", allowed);
  error.message = `This opportunity cannot be marked won yet: a proposal needs approval from ${waiting.join(", ")}`;
  throw error;
}
