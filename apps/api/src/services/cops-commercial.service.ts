import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import {
  appendCopsEvent,
  computeProposalTotals,
  defaultPriceBasis,
  COPS_TRANSITIONS,
  createCopsEvent,
  proposalApprovalTerms,
  proposalContentHash,
  type CommercialLineKind,
  type PriceBasis,
  type ProposalApprovalTerms,
  type ProposalTermsInput,
} from "@skout/shared";
import { writeCopsAudit } from "./cops-platform.service.js";
import { carryOrVoidApprovals } from "./cops-approvals.service.js";
import { runLifecycleTransition } from "./cops-lifecycle.service.js";

/**
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md (COPS-03 additions).
 *   - Tables touched directly: deals - read (existence, company, amount, deal_type) and write of deals.deal_type only (owned by apps/crm)
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: Proposals, contracts, payment requests and the gate are written in one transaction with the
 *     opportunity check, the audit row and the outbox event. An HTTP call into apps/crm cannot take part
 *     in that transaction.
 *   - Review date: revisit when apps/crm's internal API covers transactional writes
 */

const {
  deals,
  proposals,
  proposalVersions,
  proposalLineItems,
  contracts,
  contractVersions,
  copsLifecycleStates,
} = schema;

export type CommercialErrorCode =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "BUSINESS_STATE_CONFLICT"
  | "VALIDATION_FAILED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_ERROR";

/** Thrown by the commercial services; routes turn it into the COPS error envelope. */
export class CommercialError extends Error {
  constructor(
    public readonly code: CommercialErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "CommercialError";
  }

  get status(): number {
    switch (this.code) {
      case "NOT_FOUND":
        return 404;
      case "FORBIDDEN":
        return 403;
      case "BUSINESS_STATE_CONFLICT":
        return 409;
      case "VALIDATION_FAILED":
        return 422;
      case "PROVIDER_UNAVAILABLE":
        return 503;
      case "PROVIDER_ERROR":
        return 502;
    }
  }

  get retryable(): boolean {
    return this.code === "PROVIDER_ERROR";
  }
}

export interface CommercialContext {
  workspaceId: string;
  userId: string;
  requestId: string;
}

type Tx = Db;

export async function getOpportunity(db: Db, workspaceId: string, opportunityId: string) {
  const [deal] = await db
    .select({
      id: deals.id,
      companyId: deals.companyId,
      name: deals.name,
      amount: deals.amount,
      currency: deals.currency,
      dealType: deals.dealType,
    })
    .from(deals)
    .where(and(eq(deals.id, opportunityId), eq(deals.workspaceId, workspaceId), isNull(deals.deletedAt)))
    .limit(1);
  if (!deal) throw new CommercialError("NOT_FOUND", "Opportunity not found");
  return deal;
}

/**
 * Move the opportunity's commercial lifecycle forward when the COPS-01 table allows it. A move the
 * table does not allow (e.g. already complete) is skipped: commercial writes never fail on it.
 */
export async function advanceCommercialState(
  tx: Tx,
  input: {
    workspaceId: string;
    opportunityId: string;
    to: "msa_pending" | "payment_pending" | "complete";
    actorId: string | null;
    actorType?: "user" | "system" | "integration";
    reason: string;
    requestId: string;
  }
): Promise<boolean> {
  await tx
    .insert(copsLifecycleStates)
    .values({ workspaceId: input.workspaceId, dimension: "commercial", entityId: input.opportunityId, state: "proposal_sent" })
    .onConflictDoNothing();
  const [current] = await tx
    .select({ state: copsLifecycleStates.state })
    .from(copsLifecycleStates)
    .where(
      and(
        eq(copsLifecycleStates.workspaceId, input.workspaceId),
        eq(copsLifecycleStates.dimension, "commercial"),
        eq(copsLifecycleStates.entityId, input.opportunityId)
      )
    )
    .limit(1);
  const allowed = (COPS_TRANSITIONS.commercial as Record<string, readonly string[]>)[current?.state ?? ""] ?? [];
  if (!allowed.includes(input.to)) return false;
  await runLifecycleTransition(tx, {
    workspaceId: input.workspaceId,
    dimension: "commercial",
    entityId: input.opportunityId,
    to: input.to,
    actorId: input.actorId,
    actorType: input.actorType,
    source: input.actorType === "integration" ? "webhook" : "api",
    reason: input.reason,
    requestId: input.requestId,
    occurredAt: new Date(),
  });
  return true;
}

// ---- Proposals ----

async function insertProposalVersion(
  tx: Tx,
  input: { workspaceId: string; proposalId: string; version: number; terms: ProposalTermsInput; userId: string }
) {
  let computed: ReturnType<typeof computeProposalTotals>;
  try {
    computed = computeProposalTotals(input.terms);
  } catch (error) {
    throw new CommercialError("VALIDATION_FAILED", error instanceof Error ? error.message : "Invalid line items", {
      fields: [{ path: "line_items", code: "invalid", message: error instanceof Error ? error.message : "Invalid" }],
    });
  }
  const approvalTerms = proposalApprovalTerms(input.terms);
  const [version] = await tx
    .insert(proposalVersions)
    .values({
      workspaceId: input.workspaceId,
      proposalId: input.proposalId,
      version: input.version,
      currency: input.terms.currency,
      billingCadence: input.terms.billing_cadence,
      termMonths: input.terms.term_months,
      discountPct: String(input.terms.discount_pct ?? 0),
      taxPct: String(input.terms.tax_pct ?? 0),
      notes: input.terms.notes ?? null,
      paymentTermsNetDays: approvalTerms.payment_terms_net_days,
      freeCredits: approvalTerms.free_credits,
      customClauses: approvalTerms.custom_clauses,
      nonStandardSla: approvalTerms.non_standard_sla,
      subtotalMinor: computed.totals.subtotal_minor,
      discountMinor: computed.totals.discount_minor,
      taxMinor: computed.totals.tax_minor,
      totalMinor: computed.totals.total_minor,
      createdBy: input.userId,
    })
    .returning({ id: proposalVersions.id });
  await tx.insert(proposalLineItems).values(
    computed.lines.map((line) => ({
      workspaceId: input.workspaceId,
      versionId: version.id,
      position: line.position,
      kind: line.kind,
      priceBasis: line.price_basis ?? defaultPriceBasis(line.kind),
      description: line.description,
      quantity: line.quantity,
      unitAmountMinor: line.unit_amount_minor,
      discountPct: String(line.discount_pct),
      grossMinor: line.gross_minor,
      discountMinor: line.discount_minor,
      netMinor: line.net_minor,
    }))
  );
  return { versionId: version.id, totals: computed.totals };
}

async function lockProposal(tx: Tx, workspaceId: string, proposalId: string) {
  const [row] = await tx
    .select()
    .from(proposals)
    .where(and(eq(proposals.id, proposalId), eq(proposals.workspaceId, workspaceId)))
    .for("update")
    .limit(1);
  if (!row) throw new CommercialError("NOT_FOUND", "Proposal not found");
  return row;
}

const CLOSED_PROPOSAL = ["accepted", "declined", "expired"];

/**
 * COPS-08: the currency of an opportunity is locked once any of its proposals has been sent. The
 * customer has seen a price in that currency; a later version or a second proposal in another
 * currency would be a silent conversion, and prices are never converted.
 */
async function assertCurrencyUnlocked(tx: Tx, workspaceId: string, opportunityId: string, currency: string): Promise<void> {
  const [sent] = await tx
    .select({ currency: proposalVersions.currency })
    .from(proposalVersions)
    .innerJoin(proposals, eq(proposals.id, proposalVersions.proposalId))
    .where(and(eq(proposals.workspaceId, workspaceId), eq(proposals.opportunityId, opportunityId), isNotNull(proposalVersions.sentAt)))
    .orderBy(proposalVersions.sentAt)
    .limit(1);
  if (sent && sent.currency !== currency) {
    throw new CommercialError("BUSINESS_STATE_CONFLICT", `The currency is locked to ${sent.currency}: a proposal in ${sent.currency} has already been sent for this opportunity`, {
      locked_currency: sent.currency,
      requested_currency: currency,
    });
  }
}

export async function createProposal(
  db: Db,
  ctx: CommercialContext,
  opportunityId: string,
  input: ProposalTermsInput & { title: string }
): Promise<string> {
  await getOpportunity(db, ctx.workspaceId, opportunityId);
  return db.transaction(async (tx) => {
    await assertCurrencyUnlocked(tx as unknown as Tx, ctx.workspaceId, opportunityId, input.currency);
    const [proposal] = await tx
      .insert(proposals)
      .values({ workspaceId: ctx.workspaceId, opportunityId, title: input.title, createdBy: ctx.userId })
      .returning({ id: proposals.id });
    const { totals } = await insertProposalVersion(tx as unknown as Tx, {
      workspaceId: ctx.workspaceId,
      proposalId: proposal.id,
      version: 1,
      terms: input,
      userId: ctx.userId,
    });
    await writeCopsAudit(tx, {
      tenantId: ctx.workspaceId,
      actor: { type: "user", id: ctx.userId },
      entityType: "proposal",
      entityId: proposal.id,
      action: "proposal.created",
      after: { opportunity_id: opportunityId, version: 1, currency: input.currency, total_minor: totals.total_minor },
      correlationId: ctx.requestId,
      sourceChannel: "api",
    });
    return proposal.id;
  });
}

/** Every edit is a new version; existing versions are never changed. */
export async function addProposalVersion(db: Db, ctx: CommercialContext, proposalId: string, terms: ProposalTermsInput) {
  return db.transaction(async (tx) => {
    const proposal = await lockProposal(tx as unknown as Tx, ctx.workspaceId, proposalId);
    if (CLOSED_PROPOSAL.includes(proposal.status)) {
      throw new CommercialError("BUSINESS_STATE_CONFLICT", `Proposal is ${proposal.status}; create a new proposal instead`, {
        status: proposal.status,
      });
    }
    await assertCurrencyUnlocked(tx as unknown as Tx, ctx.workspaceId, proposal.opportunityId, terms.currency);
    const next = proposal.currentVersion + 1;
    const { totals } = await insertProposalVersion(tx as unknown as Tx, {
      workspaceId: ctx.workspaceId,
      proposalId,
      version: next,
      terms,
      userId: ctx.userId,
    });
    await tx
      .update(proposals)
      .set({ currentVersion: next, status: "draft", updatedAt: new Date() })
      .where(eq(proposals.id, proposalId));
    // COPS-08: an approval given for other terms does not survive a material change.
    await carryOrVoidApprovals(tx as unknown as Parameters<typeof carryOrVoidApprovals>[0], ctx, proposalId);
    await writeCopsAudit(tx, {
      tenantId: ctx.workspaceId,
      actor: { type: "user", id: ctx.userId },
      entityType: "proposal",
      entityId: proposalId,
      action: "proposal.versioned",
      before: { version: proposal.currentVersion, status: proposal.status },
      after: { version: next, status: "draft", total_minor: totals.total_minor },
      correlationId: ctx.requestId,
      sourceChannel: "api",
    });
    return next;
  });
}

/** Freeze the latest version (content hash + sent_at) and emit ProposalSent. */
export async function sendProposal(db: Db, ctx: CommercialContext, proposalId: string) {
  return db.transaction(async (tx) => {
    const proposal = await lockProposal(tx as unknown as Tx, ctx.workspaceId, proposalId);
    if (CLOSED_PROPOSAL.includes(proposal.status)) {
      throw new CommercialError("BUSINESS_STATE_CONFLICT", `Proposal is ${proposal.status}`, { status: proposal.status });
    }
    const [version] = await tx
      .select()
      .from(proposalVersions)
      .where(and(eq(proposalVersions.proposalId, proposalId), eq(proposalVersions.version, proposal.currentVersion)))
      .limit(1);
    if (!version) throw new Error("Current proposal version missing");
    if (version.sentAt) {
      throw new CommercialError("BUSINESS_STATE_CONFLICT", "The latest version was already sent; create a new version to change it", {
        version: version.version,
      });
    }
    const lines = await tx
      .select()
      .from(proposalLineItems)
      .where(eq(proposalLineItems.versionId, version.id))
      .orderBy(asc(proposalLineItems.position));
    const contentHash = hashOfStoredVersion(version, lines);
    const sentAt = new Date();
    await tx
      .update(proposalVersions)
      .set({ sentAt, sentBy: ctx.userId, contentHash })
      .where(eq(proposalVersions.id, version.id));
    await tx
      .update(proposals)
      .set({ status: "sent", statusChangedAt: sentAt, statusChangedBy: ctx.userId, statusReason: null, updatedAt: sentAt })
      .where(eq(proposals.id, proposalId));
    // Sending a proposal is the commercial dimension's starting state (COPS-01: proposal_sent).
    await tx
      .insert(copsLifecycleStates)
      .values({ workspaceId: ctx.workspaceId, dimension: "commercial", entityId: proposal.opportunityId, state: "proposal_sent" })
      .onConflictDoNothing();
    await writeCopsAudit(tx, {
      tenantId: ctx.workspaceId,
      actor: { type: "user", id: ctx.userId },
      entityType: "proposal",
      entityId: proposalId,
      action: "proposal.sent",
      before: { status: proposal.status },
      after: { status: "sent", version: version.version, content_hash: contentHash, total_minor: version.totalMinor },
      correlationId: ctx.requestId,
      sourceChannel: "api",
      occurredAt: sentAt,
    });
    await appendCopsEvent(
      tx as never,
      createCopsEvent({
        eventType: "ProposalSent",
        tenantId: ctx.workspaceId,
        aggregateType: "proposal",
        aggregateId: proposalId,
        actor: { type: "user", id: ctx.userId },
        correlationId: ctx.requestId,
        payload: { proposal_id: proposalId, opportunity_id: proposal.opportunityId },
        occurredAt: sentAt,
      })
    );
    return { version: version.version, contentHash, sentAt };
  });
}

export async function setProposalStatus(
  db: Db,
  ctx: CommercialContext,
  proposalId: string,
  status: "accepted" | "declined" | "expired",
  reason: string
) {
  return db.transaction(async (tx) => {
    const proposal = await lockProposal(tx as unknown as Tx, ctx.workspaceId, proposalId);
    if (proposal.status !== "sent") {
      throw new CommercialError("BUSINESS_STATE_CONFLICT", `Only a sent proposal can be marked ${status}`, {
        status: proposal.status,
        allowed_from: ["sent"],
      });
    }
    const at = new Date();
    await tx
      .update(proposals)
      .set({ status, statusReason: reason, statusChangedAt: at, statusChangedBy: ctx.userId, updatedAt: at })
      .where(eq(proposals.id, proposalId));
    await writeCopsAudit(tx, {
      tenantId: ctx.workspaceId,
      actor: { type: "user", id: ctx.userId },
      entityType: "proposal",
      entityId: proposalId,
      action: `proposal.${status}`,
      before: { status: proposal.status },
      after: { status },
      reason,
      correlationId: ctx.requestId,
      sourceChannel: "api",
      occurredAt: at,
    });
  });
}

/**
 * A draft that was never sent can be thrown away (duplicates, mistakes). Its versions, line
 * items and approvals go with it. Anything sent stays: it is customer-facing and immutable.
 * The audit row keeps what was deleted and why.
 */
export async function discardDraftProposal(db: Db, ctx: CommercialContext, proposalId: string, reason: string) {
  return db.transaction(async (tx) => {
    const proposal = await lockProposal(tx as unknown as Tx, ctx.workspaceId, proposalId);
    if (proposal.status !== "draft") {
      throw new CommercialError("BUSINESS_STATE_CONFLICT", "Only a draft proposal can be deleted; a sent proposal is kept as sent", {
        status: proposal.status,
        allowed_from: ["draft"],
      });
    }
    const at = new Date();
    await tx.delete(proposals).where(and(eq(proposals.id, proposalId), eq(proposals.workspaceId, ctx.workspaceId)));
    await writeCopsAudit(tx, {
      tenantId: ctx.workspaceId,
      actor: { type: "user", id: ctx.userId },
      entityType: "proposal",
      entityId: proposalId,
      action: "proposal.discarded",
      before: { status: proposal.status, title: proposal.title, opportunity_id: proposal.opportunityId, current_version: proposal.currentVersion },
      after: null,
      reason,
      correlationId: ctx.requestId,
      sourceChannel: "api",
      occurredAt: at,
    });
  });
}

type VersionRow = typeof proposalVersions.$inferSelect;
type LineRow = typeof proposalLineItems.$inferSelect;

export function storedApprovalTerms(version: VersionRow): ProposalApprovalTerms {
  return {
    payment_terms_net_days: version.paymentTermsNetDays,
    free_credits: version.freeCredits,
    custom_clauses: version.customClauses,
    non_standard_sla: version.nonStandardSla,
  };
}

function hashOfStoredVersion(version: VersionRow, lines: LineRow[]): string {
  return proposalContentHash({
    currency: version.currency,
    billing_cadence: version.billingCadence,
    term_months: version.termMonths,
    discount_pct: Number(version.discountPct),
    tax_pct: Number(version.taxPct),
    notes: version.notes,
    approval_terms: storedApprovalTerms(version),
    line_items: lines.map((l) => ({
      position: l.position,
      kind: l.kind as CommercialLineKind,
      description: l.description,
      quantity: l.quantity,
      unit_amount_minor: Number(l.unitAmountMinor),
      discount_pct: Number(l.discountPct),
      price_basis: (l.priceBasis as PriceBasis | null) ?? undefined,
    })),
    totals: {
      subtotal_minor: Number(version.subtotalMinor),
      discount_minor: Number(version.discountMinor),
      tax_minor: Number(version.taxMinor),
      total_minor: Number(version.totalMinor),
    },
  });
}

function versionDto(version: VersionRow, lines: LineRow[]) {
  return {
    id: version.id,
    version: version.version,
    currency: version.currency,
    billing_cadence: version.billingCadence,
    term_months: version.termMonths,
    discount_pct: Number(version.discountPct),
    tax_pct: Number(version.taxPct),
    notes: version.notes,
    ...storedApprovalTerms(version),
    totals: {
      subtotal_minor: Number(version.subtotalMinor),
      discount_minor: Number(version.discountMinor),
      tax_minor: Number(version.taxMinor),
      total_minor: Number(version.totalMinor),
    },
    line_items: lines.map((l) => ({
      id: l.id,
      position: l.position,
      kind: l.kind,
      price_basis: l.priceBasis ?? defaultPriceBasis(l.kind),
      description: l.description,
      quantity: l.quantity,
      unit_amount_minor: Number(l.unitAmountMinor),
      discount_pct: Number(l.discountPct),
      gross_minor: Number(l.grossMinor),
      discount_minor: Number(l.discountMinor),
      net_minor: Number(l.netMinor),
    })),
    sent_at: version.sentAt?.toISOString() ?? null,
    sent_by: version.sentBy,
    content_hash: version.contentHash,
    // Recomputed on every read: false means the stored content no longer matches what was sent.
    hash_valid: version.contentHash ? hashOfStoredVersion(version, lines) === version.contentHash : null,
    created_at: version.createdAt.toISOString(),
    created_by: version.createdBy,
  };
}

/** Proposals with versions and line items, in three queries regardless of how many there are. */
export async function loadProposals(db: Db, workspaceId: string, where: { proposalId?: string; opportunityIds?: string[] }) {
  if (where.opportunityIds && where.opportunityIds.length === 0) return [];
  const rows = await db
    .select()
    .from(proposals)
    .where(
      and(
        eq(proposals.workspaceId, workspaceId),
        where.proposalId ? eq(proposals.id, where.proposalId) : undefined,
        where.opportunityIds ? inArray(proposals.opportunityId, where.opportunityIds) : undefined
      )
    )
    .orderBy(desc(proposals.createdAt));
  if (rows.length === 0) return [];
  const versions = await db
    .select()
    .from(proposalVersions)
    .where(inArray(proposalVersions.proposalId, rows.map((r) => r.id)))
    .orderBy(asc(proposalVersions.version));
  const lines = versions.length
    ? await db
        .select()
        .from(proposalLineItems)
        .where(inArray(proposalLineItems.versionId, versions.map((v) => v.id)))
        .orderBy(asc(proposalLineItems.position))
    : [];
  return rows.map((p) => ({
    id: p.id,
    opportunity_id: p.opportunityId,
    title: p.title,
    status: p.status,
    current_version: p.currentVersion,
    status_reason: p.statusReason,
    status_changed_at: p.statusChangedAt?.toISOString() ?? null,
    status_changed_by: p.statusChangedBy,
    created_at: p.createdAt.toISOString(),
    versions: versions
      .filter((v) => v.proposalId === p.id)
      .map((v) => versionDto(v, lines.filter((l) => l.versionId === v.id))),
  }));
}

// ---- Contracts ----

const CLOSED_CONTRACT = ["signed", "declined", "expired"];
const CONTRACT_TITLES: Record<string, string> = { msa: "Master Services Agreement", order_form: "Order Form", dpa: "Data Processing Agreement" };

async function lockContract(tx: Tx, workspaceId: string, contractId: string) {
  const [row] = await tx
    .select()
    .from(contracts)
    .where(and(eq(contracts.id, contractId), eq(contracts.workspaceId, workspaceId)))
    .for("update")
    .limit(1);
  if (!row) throw new CommercialError("NOT_FOUND", "Contract not found");
  return row;
}

export interface ContractDocumentInput {
  document_url: string;
  file_name?: string;
  file_sha256: string;
}

export async function createContract(
  db: Db,
  ctx: CommercialContext,
  opportunityId: string,
  input: ContractDocumentInput & { kind: "msa" | "order_form" | "dpa"; title?: string; proposal_id?: string }
): Promise<string> {
  await getOpportunity(db, ctx.workspaceId, opportunityId);
  if (input.proposal_id) {
    const [proposal] = await db
      .select({ id: proposals.id })
      .from(proposals)
      .where(
        and(
          eq(proposals.id, input.proposal_id),
          eq(proposals.workspaceId, ctx.workspaceId),
          eq(proposals.opportunityId, opportunityId)
        )
      )
      .limit(1);
    if (!proposal) {
      throw new CommercialError("VALIDATION_FAILED", "proposal_id is not a proposal of this opportunity", {
        fields: [{ path: "proposal_id", code: "invalid", message: "Not a proposal of this opportunity" }],
      });
    }
  }
  return db.transaction(async (tx) => {
    const [contract] = await tx
      .insert(contracts)
      .values({
        workspaceId: ctx.workspaceId,
        opportunityId,
        proposalId: input.proposal_id ?? null,
        kind: input.kind,
        title: input.title?.trim() || CONTRACT_TITLES[input.kind]!,
        createdBy: ctx.userId,
      })
      .returning({ id: contracts.id });
    await tx.insert(contractVersions).values({
      workspaceId: ctx.workspaceId,
      contractId: contract.id,
      version: 1,
      documentUrl: input.document_url,
      fileName: input.file_name ?? null,
      fileSha256: input.file_sha256,
      createdBy: ctx.userId,
    });
    await writeCopsAudit(tx, {
      tenantId: ctx.workspaceId,
      actor: { type: "user", id: ctx.userId },
      entityType: "contract",
      entityId: contract.id,
      action: "contract.created",
      after: { opportunity_id: opportunityId, kind: input.kind, version: 1, file_sha256: input.file_sha256 },
      correlationId: ctx.requestId,
      sourceChannel: "api",
    });
    return contract.id;
  });
}

export async function addContractVersion(db: Db, ctx: CommercialContext, contractId: string, input: ContractDocumentInput) {
  return db.transaction(async (tx) => {
    const contract = await lockContract(tx as unknown as Tx, ctx.workspaceId, contractId);
    if (CLOSED_CONTRACT.includes(contract.status)) {
      throw new CommercialError("BUSINESS_STATE_CONFLICT", `Contract is ${contract.status}`, { status: contract.status });
    }
    const next = contract.currentVersion + 1;
    await tx.insert(contractVersions).values({
      workspaceId: ctx.workspaceId,
      contractId,
      version: next,
      documentUrl: input.document_url,
      fileName: input.file_name ?? null,
      fileSha256: input.file_sha256,
      createdBy: ctx.userId,
    });
    await tx
      .update(contracts)
      .set({ currentVersion: next, status: "draft", updatedAt: new Date() })
      .where(eq(contracts.id, contractId));
    await writeCopsAudit(tx, {
      tenantId: ctx.workspaceId,
      actor: { type: "user", id: ctx.userId },
      entityType: "contract",
      entityId: contractId,
      action: "contract.versioned",
      before: { version: contract.currentVersion, status: contract.status },
      after: { version: next, status: "draft", file_sha256: input.file_sha256 },
      correlationId: ctx.requestId,
      sourceChannel: "api",
    });
    return next;
  });
}

export async function sendContract(db: Db, ctx: CommercialContext, contractId: string) {
  return db.transaction(async (tx) => {
    const contract = await lockContract(tx as unknown as Tx, ctx.workspaceId, contractId);
    if (CLOSED_CONTRACT.includes(contract.status)) {
      throw new CommercialError("BUSINESS_STATE_CONFLICT", `Contract is ${contract.status}`, { status: contract.status });
    }
    const [version] = await tx
      .select()
      .from(contractVersions)
      .where(and(eq(contractVersions.contractId, contractId), eq(contractVersions.version, contract.currentVersion)))
      .limit(1);
    if (!version) throw new Error("Current contract version missing");
    if (version.sentAt) {
      throw new CommercialError("BUSINESS_STATE_CONFLICT", "The latest version was already sent; add a new version to change it", {
        version: version.version,
      });
    }
    const sentAt = new Date();
    await tx.update(contractVersions).set({ sentAt, sentBy: ctx.userId }).where(eq(contractVersions.id, version.id));
    await tx
      .update(contracts)
      .set({ status: "sent", statusChangedAt: sentAt, statusChangedBy: ctx.userId, statusReason: null, updatedAt: sentAt })
      .where(eq(contracts.id, contractId));
    await writeCopsAudit(tx, {
      tenantId: ctx.workspaceId,
      actor: { type: "user", id: ctx.userId },
      entityType: "contract",
      entityId: contractId,
      action: "contract.sent",
      before: { status: contract.status },
      after: { status: "sent", version: version.version, file_sha256: version.fileSha256 },
      correlationId: ctx.requestId,
      sourceChannel: "api",
      occurredAt: sentAt,
    });
    await appendCopsEvent(
      tx as never,
      createCopsEvent({
        eventType: "ContractSent",
        tenantId: ctx.workspaceId,
        aggregateType: "contract",
        aggregateId: contractId,
        actor: { type: "user", id: ctx.userId },
        correlationId: ctx.requestId,
        payload: { contract_id: contractId, opportunity_id: contract.opportunityId },
        occurredAt: sentAt,
      })
    );
    if (contract.kind !== "dpa") {
      await advanceCommercialState(tx as unknown as Tx, {
        workspaceId: ctx.workspaceId,
        opportunityId: contract.opportunityId,
        to: "msa_pending",
        actorId: ctx.userId,
        reason: `${contract.title} sent`,
        requestId: ctx.requestId,
      });
    }
    return { version: version.version, sentAt, opportunityId: contract.opportunityId };
  });
}

/**
 * Manual status (Phase 1 has no e-sign provider). `onSigned` runs in the same transaction after a
 * signature so the gate evaluation commits or rolls back with it.
 */
/** Same rule as proposals: only a contract that was never sent can be deleted. */
export async function discardDraftContract(db: Db, ctx: CommercialContext, contractId: string, reason: string) {
  return db.transaction(async (tx) => {
    const contract = await lockContract(tx as unknown as Tx, ctx.workspaceId, contractId);
    if (contract.status !== "draft") {
      throw new CommercialError("BUSINESS_STATE_CONFLICT", "Only a draft contract can be deleted; a sent contract is kept as sent", {
        status: contract.status,
        allowed_from: ["draft"],
      });
    }
    const at = new Date();
    await tx.delete(contracts).where(and(eq(contracts.id, contractId), eq(contracts.workspaceId, ctx.workspaceId)));
    await writeCopsAudit(tx, {
      tenantId: ctx.workspaceId,
      actor: { type: "user", id: ctx.userId },
      entityType: "contract",
      entityId: contractId,
      action: "contract.discarded",
      before: { status: contract.status, kind: contract.kind, title: contract.title, opportunity_id: contract.opportunityId },
      after: null,
      reason,
      correlationId: ctx.requestId,
      sourceChannel: "api",
      occurredAt: at,
    });
  });
}

export async function setContractStatus(
  db: Db,
  ctx: CommercialContext,
  contractId: string,
  input: { status: "signed" | "declined" | "expired"; reason: string; signedAt?: Date },
  onSigned?: (tx: Tx, contract: { opportunityId: string; kind: string }) => Promise<void>,
  /** COPS-08: set when an e-sign provider event, not a person, changes the status. */
  integration?: { type: "integration"; id: string }
) {
  const actor = integration ?? { type: "user" as const, id: ctx.userId };
  return db.transaction(async (tx) => {
    const contract = await lockContract(tx as unknown as Tx, ctx.workspaceId, contractId);
    if (contract.status !== "sent") {
      throw new CommercialError("BUSINESS_STATE_CONFLICT", `Only a sent contract can be marked ${input.status}`, {
        status: contract.status,
        allowed_from: ["sent"],
      });
    }
    const at = new Date();
    const signedAt = input.status === "signed" ? (input.signedAt ?? at) : null;
    await tx
      .update(contracts)
      .set({
        status: input.status,
        statusReason: input.reason,
        statusChangedAt: at,
        statusChangedBy: integration ? null : ctx.userId,
        signedAt,
        updatedAt: at,
      })
      .where(eq(contracts.id, contractId));
    await writeCopsAudit(tx, {
      tenantId: ctx.workspaceId,
      actor,
      entityType: "contract",
      entityId: contractId,
      action: `contract.${input.status}`,
      before: { status: contract.status },
      after: { status: input.status, signed_at: signedAt?.toISOString() ?? null },
      reason: input.reason,
      correlationId: ctx.requestId,
      sourceChannel: integration ? "webhook" : "api",
      occurredAt: at,
    });
    if (input.status === "signed") {
      await appendCopsEvent(
        tx as never,
        createCopsEvent({
          eventType: "ContractSigned",
          tenantId: ctx.workspaceId,
          aggregateType: "contract",
          aggregateId: contractId,
          actor,
          correlationId: ctx.requestId,
          payload: { contract_id: contractId, opportunity_id: contract.opportunityId },
          occurredAt: at,
        })
      );
      if (onSigned) await onSigned(tx as unknown as Tx, { opportunityId: contract.opportunityId, kind: contract.kind });
    }
  });
}

export async function loadContracts(db: Db, workspaceId: string, where: { contractId?: string; opportunityIds?: string[] }) {
  if (where.opportunityIds && where.opportunityIds.length === 0) return [];
  const rows = await db
    .select()
    .from(contracts)
    .where(
      and(
        eq(contracts.workspaceId, workspaceId),
        where.contractId ? eq(contracts.id, where.contractId) : undefined,
        where.opportunityIds ? inArray(contracts.opportunityId, where.opportunityIds) : undefined
      )
    )
    .orderBy(desc(contracts.createdAt));
  if (rows.length === 0) return [];
  const versions = await db
    .select()
    .from(contractVersions)
    .where(inArray(contractVersions.contractId, rows.map((r) => r.id)))
    .orderBy(asc(contractVersions.version));
  return rows.map((c) => ({
    id: c.id,
    opportunity_id: c.opportunityId,
    proposal_id: c.proposalId,
    kind: c.kind,
    title: c.title,
    status: c.status,
    current_version: c.currentVersion,
    status_reason: c.statusReason,
    redline_status: c.redlineStatus,
    status_changed_at: c.statusChangedAt?.toISOString() ?? null,
    signed_at: c.signedAt?.toISOString() ?? null,
    created_at: c.createdAt.toISOString(),
    versions: versions
      .filter((v) => v.contractId === c.id)
      .map((v) => ({
        id: v.id,
        version: v.version,
        document_url: v.documentUrl,
        file_name: v.fileName,
        file_sha256: v.fileSha256,
        sent_at: v.sentAt?.toISOString() ?? null,
        created_at: v.createdAt.toISOString(),
      })),
  }));
}

/**
 * COPS-08 (Bible p.32): attach a version negotiated outside Skout and say where the redline stands.
 * It is a new immutable contract version like any other; earlier versions stay as they were.
 */
export async function attachNegotiatedVersion(db: Db, ctx: CommercialContext, contractId: string, input: ContractDocumentInput & { redline_status: string; note?: string }) {
  const version = await addContractVersion(db, ctx, contractId, { document_url: input.document_url, file_name: input.file_name, file_sha256: input.file_sha256 });
  await db.transaction(async (tx) => {
    const [before] = await tx.select({ redlineStatus: contracts.redlineStatus }).from(contracts).where(and(eq(contracts.id, contractId), eq(contracts.workspaceId, ctx.workspaceId))).limit(1);
    await tx.update(contracts).set({ redlineStatus: input.redline_status, updatedAt: new Date() }).where(eq(contracts.id, contractId));
    await writeCopsAudit(tx, {
      tenantId: ctx.workspaceId,
      actor: { type: "user", id: ctx.userId },
      entityType: "contract",
      entityId: contractId,
      action: "contract.negotiated_version_attached",
      before: { redline_status: before?.redlineStatus ?? null },
      after: { redline_status: input.redline_status, file_sha256: input.file_sha256 },
      reason: input.note,
      correlationId: ctx.requestId,
      sourceChannel: "api",
    });
  });
  return version;
}
