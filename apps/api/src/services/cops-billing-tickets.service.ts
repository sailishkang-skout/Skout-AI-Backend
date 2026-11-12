import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { getMemberPermissions } from "@skout/auth";
import { appendActivityRecorded } from "@skout/shared";
import { writeCopsAudit } from "./cops-platform.service.js";

/*
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md (billing ticket additions).
 *   - Tables touched directly: companies, deals (read only), activities (insert: one timeline row per step) - owned by apps/crm
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: a billing ticket must check, in the same request, that the payment or subscription
 *     belongs to the customer it is raised on (payment -> deal -> company) and show the customer's
 *     name in Finance's queue; the timeline row is written next to the audit row, as the other
 *     CustomerOps writers already do (cops-playbooks, cops-follow-up-actions).
 *   - Review date: revisit when apps/crm's internal API covers transactional writes
 */
const { copsBillingTickets, companies, deals, paymentRequests, subscriptions, users, activities } = schema;

export const BILLING_TICKET_KINDS = ["refund", "cancel"] as const;
export const BILLING_TICKET_STATUSES = ["open", "in_progress", "done", "declined"] as const;
export type BillingTicketKind = (typeof BILLING_TICKET_KINDS)[number];
export type BillingTicketStatus = (typeof BILLING_TICKET_STATUSES)[number];

/** Who may act on a billing ticket (take it, assign it, close it): Finance and billing admins. */
export const BILLING_TICKET_ACT_KEYS = ["billing:refund", "billing:write", "billing:manage"] as const;

export interface BillingTicketContext {
  workspaceId: string;
  userId: string;
  requestId: string;
}

export class BillingTicketError extends Error {
  constructor(
    public readonly code: "VALIDATION_FAILED" | "NOT_FOUND" | "BUSINESS_STATE_CONFLICT",
    message: string,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

export interface BillingTicketDto {
  id: string;
  account_id: string;
  account_name: string | null;
  kind: BillingTicketKind;
  status: BillingTicketStatus;
  payment_request_id: string | null;
  subscription_id: string | null;
  /** The payment being refunded, so Finance sees the amount without opening it. */
  payment: { amount_minor: number; currency: string; status: string; paid_at: string | null } | null;
  subscription: { status: string; cancel_at: string | null; term_end: string } | null;
  reason: string;
  raised_by: { id: string; name: string } | null;
  assignee: { id: string; name: string } | null;
  resolution_note: string | null;
  resolved_by: { id: string; name: string } | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

async function people(db: Db, ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (!wanted.length) return new Map<string, string>();
  const rows = await db.select({ id: users.id, name: users.fullName, email: users.email }).from(users).where(inArray(users.id, wanted));
  return new Map(rows.map((r) => [r.id, r.name?.trim() || r.email]));
}

async function load(db: Db, workspaceId: string, where: SQL[] = []): Promise<BillingTicketDto[]> {
  const rows = await db
    .select({
      t: copsBillingTickets,
      accountName: companies.name,
      payAmount: paymentRequests.amountMinor,
      payCurrency: paymentRequests.currency,
      payStatus: paymentRequests.status,
      paidAt: paymentRequests.paidAt,
      subStatus: subscriptions.status,
      subCancelAt: subscriptions.cancelAt,
      subTermEnd: subscriptions.termEnd,
    })
    .from(copsBillingTickets)
    .leftJoin(companies, eq(companies.id, copsBillingTickets.accountId))
    .leftJoin(paymentRequests, eq(paymentRequests.id, copsBillingTickets.paymentRequestId))
    .leftJoin(subscriptions, eq(subscriptions.id, copsBillingTickets.subscriptionId))
    .where(and(eq(copsBillingTickets.workspaceId, workspaceId), ...where))
    .orderBy(desc(copsBillingTickets.createdAt))
    .limit(200);
  const names = await people(db, rows.flatMap((r) => [r.t.raisedBy, r.t.assigneeId, r.t.resolvedBy]));
  const who = (id: string | null) => (id ? { id, name: names.get(id) ?? "Unknown" } : null);
  return rows.map(({ t, ...r }) => ({
    id: t.id,
    account_id: t.accountId,
    account_name: r.accountName,
    kind: t.kind as BillingTicketKind,
    status: t.status as BillingTicketStatus,
    payment_request_id: t.paymentRequestId,
    subscription_id: t.subscriptionId,
    payment: r.payAmount != null ? { amount_minor: Number(r.payAmount), currency: r.payCurrency!, status: r.payStatus!, paid_at: iso(r.paidAt) } : null,
    subscription: r.subStatus != null ? { status: r.subStatus, cancel_at: iso(r.subCancelAt), term_end: r.subTermEnd!.toISOString() } : null,
    reason: t.reason,
    raised_by: who(t.raisedBy),
    assignee: who(t.assigneeId),
    resolution_note: t.resolutionNote,
    resolved_by: who(t.resolvedBy),
    resolved_at: iso(t.resolvedAt),
    created_at: t.createdAt.toISOString(),
    updated_at: t.updatedAt.toISOString(),
  }));
}

export async function listBillingTickets(
  db: Db,
  workspaceId: string,
  filter: { status?: BillingTicketStatus | "active"; accountId?: string; assigneeId?: string } = {}
): Promise<BillingTicketDto[]> {
  const where: SQL[] = [];
  if (filter.status === "active") where.push(inArray(copsBillingTickets.status, ["open", "in_progress"]));
  else if (filter.status) where.push(eq(copsBillingTickets.status, filter.status));
  if (filter.accountId) where.push(eq(copsBillingTickets.accountId, filter.accountId));
  if (filter.assigneeId) where.push(eq(copsBillingTickets.assigneeId, filter.assigneeId));
  return load(db, workspaceId, where);
}

async function getOne(db: Db, workspaceId: string, id: string) {
  const [row] = await load(db, workspaceId, [eq(copsBillingTickets.id, id)]);
  if (!row) throw new BillingTicketError("NOT_FOUND", "Billing ticket not found");
  return row;
}

/** One line on the customer timeline, so CS and Finance see the request where they work. */
async function timeline(db: Db, workspaceId: string, accountId: string, subject: string, body: string) {
  const [row] = await db
    .insert(activities)
    .values({ workspaceId, entityType: "company", entityId: accountId, activityType: "billing_ticket", subject, body })
    .returning({ id: activities.id });
  await appendActivityRecorded(db as never, { workspaceId, activityId: row!.id, activityType: "billing_ticket", entityType: "company", entityId: accountId, subject });
}

const money = (minor: number, currency: string) => `${currency} ${(minor / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export async function createBillingTicket(
  db: Db,
  ctx: BillingTicketContext,
  input: { accountId: string; kind: BillingTicketKind; paymentRequestId?: string; subscriptionId?: string; reason: string; assigneeId?: string | null }
): Promise<BillingTicketDto> {
  const [account] = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(and(eq(companies.id, input.accountId), eq(companies.workspaceId, ctx.workspaceId)))
    .limit(1);
  if (!account) throw new BillingTicketError("NOT_FOUND", "Customer not found");

  let summary: string;
  if (input.kind === "refund") {
    if (!input.paymentRequestId) throw new BillingTicketError("VALIDATION_FAILED", "Pick the payment to refund", { field: "payment_request_id" });
    const [pay] = await db
      .select({ status: paymentRequests.status, amount: paymentRequests.amountMinor, currency: paymentRequests.currency })
      .from(paymentRequests)
      .innerJoin(deals, eq(deals.id, paymentRequests.opportunityId))
      .where(and(eq(paymentRequests.id, input.paymentRequestId), eq(paymentRequests.workspaceId, ctx.workspaceId), eq(deals.companyId, input.accountId)))
      .limit(1);
    if (!pay) throw new BillingTicketError("NOT_FOUND", "That payment is not on this customer", { field: "payment_request_id" });
    if (pay.status !== "paid") throw new BillingTicketError("BUSINESS_STATE_CONFLICT", `Only a paid payment can be refunded; this one is ${pay.status}`, { status: pay.status });
    summary = `Refund ${money(Number(pay.amount), pay.currency)}`;
  } else {
    if (!input.subscriptionId) throw new BillingTicketError("VALIDATION_FAILED", "Pick the subscription to cancel", { field: "subscription_id" });
    const [sub] = await db
      .select({ status: subscriptions.status, cancelAt: subscriptions.cancelAt })
      .from(subscriptions)
      .where(and(eq(subscriptions.id, input.subscriptionId), eq(subscriptions.workspaceId, ctx.workspaceId), eq(subscriptions.accountId, input.accountId)))
      .limit(1);
    if (!sub) throw new BillingTicketError("NOT_FOUND", "That subscription is not on this customer", { field: "subscription_id" });
    if (sub.status === "closed" || sub.cancelAt) throw new BillingTicketError("BUSINESS_STATE_CONFLICT", "This subscription is already cancelled", { status: sub.status });
    summary = "Cancel the subscription";
  }

  // One open request per payment or subscription: a second click must not queue the same work twice.
  const target = input.kind === "refund" ? eq(copsBillingTickets.paymentRequestId, input.paymentRequestId!) : eq(copsBillingTickets.subscriptionId, input.subscriptionId!);
  const [already] = await db
    .select({ id: copsBillingTickets.id })
    .from(copsBillingTickets)
    .where(and(eq(copsBillingTickets.workspaceId, ctx.workspaceId), target, inArray(copsBillingTickets.status, ["open", "in_progress"])))
    .limit(1);
  if (already) throw new BillingTicketError("BUSINESS_STATE_CONFLICT", "There is already an open billing ticket for this", { ticket_id: already.id });

  if (input.assigneeId) await assertCanAct(db, ctx.workspaceId, input.assigneeId);

  const [row] = await db
    .insert(copsBillingTickets)
    .values({
      workspaceId: ctx.workspaceId,
      accountId: input.accountId,
      kind: input.kind,
      status: input.assigneeId ? "in_progress" : "open",
      paymentRequestId: input.kind === "refund" ? input.paymentRequestId! : null,
      subscriptionId: input.kind === "cancel" ? input.subscriptionId! : null,
      reason: input.reason,
      raisedBy: ctx.userId,
      assigneeId: input.assigneeId ?? null,
    })
    .returning({ id: copsBillingTickets.id });
  await writeCopsAudit(db, {
    tenantId: ctx.workspaceId,
    actor: { type: "user", id: ctx.userId },
    entityType: "billing_ticket",
    entityId: row!.id,
    action: "billing_ticket.raised",
    after: { kind: input.kind, account_id: input.accountId, payment_request_id: input.paymentRequestId ?? null, subscription_id: input.subscriptionId ?? null },
    reason: input.reason,
    correlationId: ctx.requestId,
    sourceChannel: "web",
  });
  await timeline(db, ctx.workspaceId, input.accountId, `Billing ticket raised: ${summary}`, input.reason);
  return getOne(db, ctx.workspaceId, row!.id);
}

/** The assignee must be able to act on it (Finance or a billing admin). */
async function assertCanAct(db: Db, workspaceId: string, userId: string) {
  const perms = await getMemberPermissions(db, workspaceId, userId);
  if (!BILLING_TICKET_ACT_KEYS.some((k) => perms.includes(k))) {
    throw new BillingTicketError("VALIDATION_FAILED", "Assign it to someone in Finance (they need the refund or billing permission)", { field: "assignee_id" });
  }
}

export async function assignBillingTicket(db: Db, ctx: BillingTicketContext, id: string, assigneeId: string | null): Promise<BillingTicketDto> {
  const current = await getOne(db, ctx.workspaceId, id);
  if (current.status === "done" || current.status === "declined") throw new BillingTicketError("BUSINESS_STATE_CONFLICT", `This ticket is already ${current.status}`);
  if (assigneeId) await assertCanAct(db, ctx.workspaceId, assigneeId);
  await db
    .update(copsBillingTickets)
    .set({ assigneeId, status: assigneeId ? "in_progress" : "open", updatedAt: new Date() })
    .where(and(eq(copsBillingTickets.id, id), eq(copsBillingTickets.workspaceId, ctx.workspaceId)));
  await writeCopsAudit(db, {
    tenantId: ctx.workspaceId,
    actor: { type: "user", id: ctx.userId },
    entityType: "billing_ticket",
    entityId: id,
    action: "billing_ticket.assigned",
    before: { assignee_id: current.assignee?.id ?? null },
    after: { assignee_id: assigneeId },
    correlationId: ctx.requestId,
    sourceChannel: "web",
  });
  return getOne(db, ctx.workspaceId, id);
}

/**
 * Close a ticket. "done" only once the work really happened: the payment is refunded, or the
 * subscription is cancelled (now or at term end). "declined" needs a note for the customer.
 */
export async function resolveBillingTicket(
  db: Db,
  ctx: BillingTicketContext,
  id: string,
  input: { outcome: "done" | "declined"; note?: string | null }
): Promise<BillingTicketDto> {
  const current = await getOne(db, ctx.workspaceId, id);
  if (current.status === "done" || current.status === "declined") throw new BillingTicketError("BUSINESS_STATE_CONFLICT", `This ticket is already ${current.status}`);
  const note = input.note?.trim() || null;
  if (input.outcome === "declined" && !note) throw new BillingTicketError("VALIDATION_FAILED", "Say why it is declined", { field: "note" });
  if (input.outcome === "done") {
    if (current.kind === "refund" && current.payment?.status !== "refunded") {
      throw new BillingTicketError("BUSINESS_STATE_CONFLICT", "Refund the payment first; the ticket closes once it is refunded", { payment_status: current.payment?.status ?? null });
    }
    if (current.kind === "cancel" && !(current.subscription?.cancel_at || current.subscription?.status === "closed")) {
      throw new BillingTicketError("BUSINESS_STATE_CONFLICT", "Cancel the subscription first; the ticket closes once it is cancelled", { subscription_status: current.subscription?.status ?? null });
    }
  }
  const [updated] = await db
    .update(copsBillingTickets)
    .set({ status: input.outcome, resolutionNote: note, resolvedBy: ctx.userId, resolvedAt: new Date(), updatedAt: new Date(), assigneeId: current.assignee?.id ?? ctx.userId })
    .where(and(eq(copsBillingTickets.id, id), eq(copsBillingTickets.workspaceId, ctx.workspaceId), inArray(copsBillingTickets.status, ["open", "in_progress"])))
    .returning({ id: copsBillingTickets.id });
  if (!updated) throw new BillingTicketError("BUSINESS_STATE_CONFLICT", "This ticket was closed by someone else");
  await writeCopsAudit(db, {
    tenantId: ctx.workspaceId,
    actor: { type: "user", id: ctx.userId },
    entityType: "billing_ticket",
    entityId: id,
    action: `billing_ticket.${input.outcome}`,
    before: { status: current.status },
    after: { status: input.outcome },
    reason: note,
    correlationId: ctx.requestId,
    sourceChannel: "web",
  });
  const what = current.kind === "refund" ? "refund" : "cancellation";
  await timeline(db, ctx.workspaceId, current.account_id, input.outcome === "done" ? `Billing ticket done: ${what} completed` : `Billing ticket declined: ${what}`, note ?? "");
  return getOne(db, ctx.workspaceId, id);
}
