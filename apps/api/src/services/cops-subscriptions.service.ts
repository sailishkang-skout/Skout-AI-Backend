import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, lte, ne } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import {
  addMonthsUtc,
  appendCopsEvent,
  createCopsEvent,
  dunningPolicySchema,
  effectiveSeats,
  nextPeriodStart,
  nextDunningStep,
  periodAmountMinor,
  periodsStarted,
  priceBookSchema,
  seatMonthMinor,
  subscriptionStatusFor,
  type DunningPolicy,
  type SubscriptionBilling,
  type SubscriptionCadence,
  type SubscriptionStatus,
} from "@skout/shared";
import { writeCopsAudit } from "./cops-platform.service.js";
import { getConfig } from "./cops-admin-config.service.js";
import { CommercialError, getOpportunity, type CommercialContext } from "./cops-commercial.service.js";
import { createPaymentRequest } from "./cops-payments.service.js";
import type { PspAdapter } from "./psp/psp-adapter.js";

/**
 * COPS-08 subscriptions (Bible p.36). A subscription bills one period at a time. With
 * `payment_link` billing each period gets a COPS-03 payment link and the failed-payment timeline
 * is ours, counted from the bill's due date: that is the route for customers the provider cannot
 * auto-debit. `invoiced` accounts are never suspended automatically. Status comes only from the
 * oldest unpaid bill, so paying it restores access with no extra step, and nothing here deletes data.
 */
const { subscriptions, subscriptionItems, subscriptionInvoices, subscriptionAmendments, paymentRequests } = schema;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type SubscriptionRow = typeof subscriptions.$inferSelect;
type ItemRow = typeof subscriptionItems.$inferSelect;
type InvoiceRow = typeof subscriptionInvoices.$inferSelect;
type AmendmentRow = typeof subscriptionAmendments.$inferSelect;

const seatChanges = (amendments: AmendmentRow[]) => amendments.map((a) => ({ seq: a.seq, seats: a.seats, effective_at: a.effectiveAt }));
const originalSeats = (items: ItemRow[]) => items.filter((i) => i.kind === "seats").reduce((sum, i) => sum + i.quantity, 0);

async function loadDunningPolicy(db: Db, workspaceId: string): Promise<DunningPolicy> {
  const config = await getConfig(db, workspaceId, "dunning_policy", "default");
  const parsed = dunningPolicySchema.safeParse(config?.value);
  if (!parsed.success) throw new CommercialError("BUSINESS_STATE_CONFLICT", "The failed-payment policy is not configured", { config: "dunning_policy" });
  return parsed.data;
}

function subscriptionDto(row: SubscriptionRow, items: ItemRow[], invoices: InvoiceRow[], amendments: AmendmentRow[], policy: DunningPolicy, now: Date) {
  const overdue = invoices.filter((i) => i.status === "open" && i.dueAt.getTime() <= now.getTime()).sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())[0];
  const state = overdue ? subscriptionStatusFor(policy, { billing: row.billing as SubscriptionBilling, oldest_overdue_due_at: overdue.dueAt, now }) : null;
  const next = overdue && state?.day != null && row.status !== "closed" ? nextDunningStep(policy, row.billing as SubscriptionBilling, overdue.dueAt, state.day) : null;
  return {
    id: row.id,
    account_id: row.accountId,
    opportunity_id: row.opportunityId,
    status: row.status as SubscriptionStatus,
    billing: row.billing as SubscriptionBilling,
    currency: row.currency,
    cadence: row.cadence as SubscriptionCadence,
    term_months: row.termMonths,
    term_start: row.termStart.toISOString(),
    /** The renewal date: the end of the term. */
    renews_at: row.termEnd.toISOString(),
    payment_terms_net_days: row.paymentTermsNetDays,
    provider_subscription_id: row.providerSubscriptionId,
    provider_plan_id: row.providerPlanId,
    renewal_opportunity_id: row.renewalOpportunityId,
    renewal_opened_at: row.renewalOpenedAt?.toISOString() ?? null,
    status_changed_at: row.statusChangedAt.toISOString(),
    items: items.map((i) => ({ id: i.id, kind: i.kind, quantity: i.quantity, unit_amount_minor: Number(i.unitAmountMinor) })),
    /** Seats in force now. A seat amendment not yet effective shows in `amendments`, not here. */
    seats: effectiveSeats(originalSeats(items), seatChanges(amendments), now),
    amendments: [...amendments]
      .sort((a, b) => a.seq - b.seq)
      .map((a) => ({ id: a.id, seq: a.seq, seats: a.seats, term_months: a.termMonths, reason: a.reason, effective_at: a.effectiveAt.toISOString(), before: a.before, after: a.after, created_by: a.createdBy, created_at: a.createdAt.toISOString() })),
    invoices: [...invoices]
      .sort((a, b) => b.periodStart.getTime() - a.periodStart.getTime())
      .map((i) => ({
        id: i.id,
        period_start: i.periodStart.toISOString(),
        period_end: i.periodEnd.toISOString(),
        due_at: i.dueAt.toISOString(),
        amount_minor: Number(i.amountMinor),
        currency: i.currency,
        status: i.status,
        payment_request_id: i.paymentRequestId,
        paid_at: i.paidAt?.toISOString() ?? null,
      })),
    dunning: overdue && state?.day != null ? { overdue_invoice_id: overdue.id, due_at: overdue.dueAt.toISOString(), day: state.day, next_status: next?.status ?? null, next_status_at: next?.at.toISOString() ?? null } : null,
  };
}
export type SubscriptionDto = ReturnType<typeof subscriptionDto>;

async function loadDto(db: Db, row: SubscriptionRow, now: Date): Promise<SubscriptionDto> {
  const items = await db.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, row.id)).orderBy(asc(subscriptionItems.createdAt));
  const invoices = await db.select().from(subscriptionInvoices).where(eq(subscriptionInvoices.subscriptionId, row.id)).orderBy(desc(subscriptionInvoices.periodStart)).limit(36);
  const amendments = await db.select().from(subscriptionAmendments).where(eq(subscriptionAmendments.subscriptionId, row.id));
  return subscriptionDto(row, items, invoices, amendments, await loadDunningPolicy(db, row.workspaceId), now);
}

/** The account's current subscription: the one that is not closed, else the most recent closed one. */
export async function getAccountSubscription(db: Db, workspaceId: string, accountId: string, now: Date = new Date()): Promise<SubscriptionDto | null> {
  const rows = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.workspaceId, workspaceId), eq(subscriptions.accountId, accountId)))
    .orderBy(desc(subscriptions.createdAt))
    .limit(20);
  const row = rows.find((r) => r.status !== "closed") ?? rows[0];
  return row ? loadDto(db, row, now) : null;
}

/** One bill per period that has started. Safe to call again: a period is billed once. */
async function ensurePeriodInvoices(tx: Tx, sub: SubscriptionRow, items: ItemRow[], now: Date, amendments: AmendmentRow[] = []): Promise<number> {
  const base = originalSeats(items);
  const changes = seatChanges(amendments);
  // A period is billed for the seats in force when it starts: a later seat change never reprices it.
  const priced = (at: Date) => items.map((i) => ({ quantity: i.kind === "seats" ? effectiveSeats(base, changes, at) : i.quantity, unit_amount_minor: Number(i.unitAmountMinor) }));
  const periods = periodsStarted(sub.termStart, sub.cadence as SubscriptionCadence, sub.termMonths, now);
  if (periods.length === 0) return 0;
  const rows = await tx
    .insert(subscriptionInvoices)
    .values(
      periods.map((p) => ({
        workspaceId: sub.workspaceId,
        subscriptionId: sub.id,
        periodStart: p.start,
        periodEnd: p.end,
        dueAt: new Date(p.start.getTime() + sub.paymentTermsNetDays * 86_400_000),
        amountMinor: periodAmountMinor(priced(p.start), p.months),
        currency: sub.currency,
      }))
    )
    .onConflictDoNothing()
    .returning({ id: subscriptionInvoices.id });
  return rows.length;
}

export interface CreateSubscriptionInput {
  opportunity_id: string;
  seats: number;
  cadence: SubscriptionCadence;
  term_months: number;
  billing?: SubscriptionBilling;
  /** Per seat per month. Left out, it comes from the price book for the currency and cadence. */
  seat_month_minor?: number;
  payment_terms_net_days?: number;
  start_at?: string;
}

export async function createSubscription(db: Db, ctx: CommercialContext, accountId: string, input: CreateSubscriptionInput, now: Date = new Date()): Promise<SubscriptionDto> {
  const billing = input.billing ?? "payment_link";
  if (billing === "provider") {
    throw new CommercialError("BUSINESS_STATE_CONFLICT", "Provider auto-debit is not available yet; use payment_link or invoiced", { billing });
  }
  const opportunity = await getOpportunity(db, ctx.workspaceId, input.opportunity_id);
  if (opportunity.companyId !== accountId) {
    throw new CommercialError("VALIDATION_FAILED", "opportunity_id is not an opportunity of this account", { fields: [{ path: "opportunity_id", code: "invalid", message: "Not an opportunity of this account" }] });
  }
  // The deal's currency is the subscription's currency. Nothing is converted.
  const currency = opportunity.currency;
  if (!currency) throw new CommercialError("VALIDATION_FAILED", "The opportunity has no currency", { fields: [{ path: "opportunity_id", code: "invalid", message: "Set the opportunity currency first" }] });
  let unit = input.seat_month_minor;
  if (unit == null) {
    const book = priceBookSchema.safeParse((await getConfig(db, ctx.workspaceId, "price_book", "default"))?.value);
    unit = book.success ? (seatMonthMinor(book.data, currency, input.cadence) ?? undefined) : undefined;
    if (unit == null) {
      throw new CommercialError("VALIDATION_FAILED", `There is no price for ${currency} in the price book; give seat_month_minor`, { fields: [{ path: "seat_month_minor", code: "required", message: `No ${currency} price in the price book` }] });
    }
  }
  const termStart = input.start_at ? new Date(input.start_at) : now;

  const id = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: subscriptions.id, status: subscriptions.status })
      .from(subscriptions)
      .where(and(eq(subscriptions.workspaceId, ctx.workspaceId), eq(subscriptions.accountId, accountId), ne(subscriptions.status, "closed")))
      .limit(1);
    if (existing) throw new CommercialError("BUSINESS_STATE_CONFLICT", "This account already has a subscription", { subscription_id: existing.id, status: existing.status });
    const [sub] = await tx
      .insert(subscriptions)
      .values({
        workspaceId: ctx.workspaceId,
        accountId,
        opportunityId: opportunity.id,
        billing,
        currency,
        cadence: input.cadence,
        termMonths: input.term_months,
        termStart,
        termEnd: addMonthsUtc(termStart, input.term_months),
        paymentTermsNetDays: input.payment_terms_net_days ?? 30,
        createdBy: ctx.userId,
      })
      .returning();
    const [item] = await tx.insert(subscriptionItems).values({ workspaceId: ctx.workspaceId, subscriptionId: sub!.id, kind: "seats", quantity: input.seats, unitAmountMinor: unit! }).returning();
    await ensurePeriodInvoices(tx, sub!, [item!], now);
    await writeCopsAudit(tx, {
      tenantId: ctx.workspaceId,
      actor: { type: "user", id: ctx.userId },
      entityType: "subscription",
      entityId: sub!.id,
      action: "subscription.created",
      after: { account_id: accountId, seats: input.seats, seat_month_minor: unit, currency, cadence: input.cadence, term_months: input.term_months, billing },
      correlationId: ctx.requestId,
      sourceChannel: "api",
    });
    return sub!.id;
  });
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1);
  return loadDto(db, row!, now);
}

async function loadInvoice(db: Db, workspaceId: string, invoiceId: string) {
  const [row] = await db
    .select({ invoice: subscriptionInvoices, subscription: subscriptions })
    .from(subscriptionInvoices)
    .innerJoin(subscriptions, eq(subscriptions.id, subscriptionInvoices.subscriptionId))
    .where(and(eq(subscriptionInvoices.id, invoiceId), eq(subscriptionInvoices.workspaceId, workspaceId)))
    .limit(1);
  if (!row) throw new CommercialError("NOT_FOUND", "Subscription bill not found");
  if (row.invoice.status !== "open") throw new CommercialError("BUSINESS_STATE_CONFLICT", `This bill is ${row.invoice.status}`, { status: row.invoice.status });
  return row;
}

/** A provider-hosted payment link for one bill, through the COPS-03 payment request flow. */
export async function issueInvoicePaymentLink(db: Db, psp: PspAdapter, ctx: CommercialContext, invoiceId: string): Promise<{ invoice_id: string; payment_request_id: string }> {
  const { invoice, subscription } = await loadInvoice(db, ctx.workspaceId, invoiceId);
  if (invoice.paymentRequestId) {
    const [request] = await db.select({ status: paymentRequests.status }).from(paymentRequests).where(eq(paymentRequests.id, invoice.paymentRequestId)).limit(1);
    // A link that is still payable is reused; only a dead one is replaced.
    if (request && ["requested", "paid"].includes(request.status)) return { invoice_id: invoice.id, payment_request_id: invoice.paymentRequestId };
  }
  const paymentRequestId = await createPaymentRequest(db, psp, ctx, {
    opportunity_id: subscription.opportunityId,
    amount_minor: Number(invoice.amountMinor),
    currency: invoice.currency,
    description: `Subscription ${invoice.periodStart.toISOString().slice(0, 10)} to ${invoice.periodEnd.toISOString().slice(0, 10)}`,
  });
  await db.update(subscriptionInvoices).set({ paymentRequestId }).where(eq(subscriptionInvoices.id, invoice.id));
  return { invoice_id: invoice.id, payment_request_id: paymentRequestId };
}

/** Finance records a payment that arrived outside the provider (invoiced accounts). Needs a reason. */
export async function markInvoicePaid(db: Db, ctx: CommercialContext, invoiceId: string, reason: string, now: Date = new Date()): Promise<void> {
  await loadInvoice(db, ctx.workspaceId, invoiceId);
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(subscriptionInvoices)
      .set({ status: "paid", paidAt: now })
      .where(and(eq(subscriptionInvoices.id, invoiceId), eq(subscriptionInvoices.status, "open")))
      .returning({ subscriptionId: subscriptionInvoices.subscriptionId });
    if (updated.length === 0) throw new CommercialError("BUSINESS_STATE_CONFLICT", "This bill is no longer open");
    await writeCopsAudit(tx, {
      tenantId: ctx.workspaceId,
      actor: { type: "user", id: ctx.userId },
      entityType: "subscription_invoice",
      entityId: invoiceId,
      action: "subscription_invoice.marked_paid",
      after: { status: "paid", subscription_id: updated[0]!.subscriptionId },
      reason,
      correlationId: ctx.requestId,
      sourceChannel: "api",
    });
  });
  await runSubscriptionBilling(db, now, { workspaceId: ctx.workspaceId });
}

export interface BillingRunResult {
  subscriptions: number;
  invoices_created: number;
  invoices_paid: number;
  status_changes: Array<{ subscription_id: string; from: SubscriptionStatus; to: SubscriptionStatus; day: number | null }>;
}

/**
 * The scheduled pass, safe to run as often as wanted. For every subscription that is not closed:
 * bills paid at the provider are marked paid, a bill is created for each period that has started,
 * and the status is set from the oldest unpaid bill. Each subscription is its own transaction, so
 * one failure does not hold up the rest.
 */
export async function runSubscriptionBilling(db: Db, now: Date = new Date(), scope: { workspaceId?: string } = {}, requestId: string = randomUUID()): Promise<BillingRunResult> {
  const result: BillingRunResult = { subscriptions: 0, invoices_created: 0, invoices_paid: 0, status_changes: [] };
  const open = await db
    .select({ id: subscriptions.id, workspaceId: subscriptions.workspaceId })
    .from(subscriptions)
    .where(and(ne(subscriptions.status, "closed"), scope.workspaceId ? eq(subscriptions.workspaceId, scope.workspaceId) : undefined));
  const policies = new Map<string, DunningPolicy>();

  for (const ref of open) {
    if (!policies.has(ref.workspaceId)) policies.set(ref.workspaceId, await loadDunningPolicy(db, ref.workspaceId));
    const policy = policies.get(ref.workspaceId)!;
    await db.transaction(async (tx) => {
      const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.id, ref.id)).for("update").limit(1);
      if (!sub || sub.status === "closed") return;
      result.subscriptions += 1;

      // Bills whose payment link has been paid (the COPS-03 webhook set the payment request to paid).
      const paid = await tx
        .select({ invoiceId: subscriptionInvoices.id, paidAt: paymentRequests.paidAt })
        .from(subscriptionInvoices)
        .innerJoin(paymentRequests, eq(paymentRequests.id, subscriptionInvoices.paymentRequestId))
        .where(and(eq(subscriptionInvoices.subscriptionId, sub.id), eq(subscriptionInvoices.status, "open"), isNotNull(subscriptionInvoices.paymentRequestId), eq(paymentRequests.status, "paid")));
      for (const p of paid) {
        await tx.update(subscriptionInvoices).set({ status: "paid", paidAt: p.paidAt ?? now }).where(eq(subscriptionInvoices.id, p.invoiceId));
      }
      result.invoices_paid += paid.length;

      const items = await tx.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, sub.id));
      const amendments = await tx.select().from(subscriptionAmendments).where(eq(subscriptionAmendments.subscriptionId, sub.id));
      result.invoices_created += await ensurePeriodInvoices(tx, sub, items, now, amendments);

      const [overdue] = await tx
        .select({ dueAt: subscriptionInvoices.dueAt })
        .from(subscriptionInvoices)
        .where(and(eq(subscriptionInvoices.subscriptionId, sub.id), eq(subscriptionInvoices.status, "open"), lte(subscriptionInvoices.dueAt, now)))
        .orderBy(asc(subscriptionInvoices.dueAt))
        .limit(1);
      const next = subscriptionStatusFor(policy, { billing: sub.billing as SubscriptionBilling, oldest_overdue_due_at: overdue?.dueAt ?? null, now });
      const from = sub.status as SubscriptionStatus;
      if (next.status === from) return;

      await tx.update(subscriptions).set({ status: next.status, statusChangedAt: now, updatedAt: now }).where(eq(subscriptions.id, sub.id));
      await writeCopsAudit(tx, {
        tenantId: sub.workspaceId,
        actor: { type: "system", id: "subscription-billing" },
        entityType: "subscription",
        entityId: sub.id,
        action: `subscription.${next.status}`,
        before: { status: from },
        after: { status: next.status, day: next.day },
        reason: next.status === "active" ? "Every bill that was due is paid" : `A bill is unpaid ${next.day} day(s) after its due date`,
        correlationId: requestId,
        sourceChannel: "system",
        occurredAt: now,
      });
      await appendCopsEvent(
        tx as never,
        createCopsEvent({
          eventType: "SubscriptionStatusChanged",
          tenantId: sub.workspaceId,
          aggregateType: "subscription",
          aggregateId: sub.id,
          actor: { type: "system", id: "subscription-billing" },
          correlationId: requestId,
          payload: { subscription_id: sub.id, account_id: sub.accountId, from, to: next.status, day: next.day },
          occurredAt: now,
        })
      );
      result.status_changes.push({ subscription_id: sub.id, from, to: next.status, day: next.day });
    });
  }
  return result;
}

/** Subscriptions in dunning, worst first, for the Finance failed-payment queue. */
export async function listFailedPayments(db: Db, workspaceId: string, now: Date = new Date()): Promise<SubscriptionDto[]> {
  const rows = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.workspaceId, workspaceId), inArray(subscriptions.status, ["past_due", "restricted", "suspended"])))
    .limit(500);
  const dtos = await Promise.all(rows.map((r) => loadDto(db, r, now)));
  return dtos.sort((a, b) => (b.dunning?.day ?? 0) - (a.dunning?.day ?? 0));
}

/**
 * A change of seats or term (Bible p.37). It is appended and never edited; the original contract
 * and earlier amendments stay as they were. Seats change with the next billing period, with no
 * proration; a new term length moves the renewal date at once.
 */
export async function amendSubscription(db: Db, ctx: CommercialContext, subscriptionId: string, input: { seats?: number; term_months?: number; reason: string }, now: Date = new Date()): Promise<SubscriptionDto> {
  if (input.seats == null && input.term_months == null) {
    throw new CommercialError("VALIDATION_FAILED", "Give seats, term_months or both", { fields: [{ path: "seats", code: "required", message: "Give seats, term_months or both" }] });
  }
  await db.transaction(async (tx) => {
    const [sub] = await tx
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.workspaceId, ctx.workspaceId)))
      .for("update")
      .limit(1);
    if (!sub) throw new CommercialError("NOT_FOUND", "Subscription not found");
    if (sub.status === "closed") throw new CommercialError("BUSINESS_STATE_CONFLICT", "A closed subscription cannot be amended", { status: sub.status });
    const items = await tx.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, sub.id));
    const earlier = await tx.select().from(subscriptionAmendments).where(eq(subscriptionAmendments.subscriptionId, sub.id));
    // Seats as they will stand once every earlier amendment has taken effect.
    const seatsBefore = effectiveSeats(originalSeats(items), seatChanges(earlier), new Date(8_640_000_000_000_000));

    let effectiveAt = now;
    if (input.seats != null) {
      const next = nextPeriodStart(sub.termStart, sub.cadence as SubscriptionCadence, input.term_months ?? sub.termMonths, now);
      if (!next) throw new CommercialError("BUSINESS_STATE_CONFLICT", "There is no later billing period in this term for a seat change to start in; change seats at renewal or extend the term", { term_end: sub.termEnd.toISOString() });
      effectiveAt = next;
    }
    let termEnd = sub.termEnd;
    if (input.term_months != null && input.term_months !== sub.termMonths) {
      termEnd = addMonthsUtc(sub.termStart, input.term_months);
      if (termEnd.getTime() <= now.getTime()) throw new CommercialError("VALIDATION_FAILED", "The new term would already be over", { fields: [{ path: "term_months", code: "too_short", message: "The new term would already be over" }] });
      await tx.update(subscriptions).set({ termMonths: input.term_months, termEnd, updatedAt: now }).where(eq(subscriptions.id, sub.id));
    }
    const before = { seats: seatsBefore, term_months: sub.termMonths, renews_at: sub.termEnd.toISOString() };
    const after = { seats: input.seats ?? seatsBefore, term_months: input.term_months ?? sub.termMonths, renews_at: termEnd.toISOString() };
    const [row] = await tx
      .insert(subscriptionAmendments)
      .values({
        workspaceId: ctx.workspaceId,
        subscriptionId: sub.id,
        seq: earlier.reduce((max, a) => Math.max(max, a.seq), 0) + 1,
        seats: input.seats ?? null,
        termMonths: input.term_months ?? null,
        reason: input.reason,
        effectiveAt,
        before,
        after,
        createdBy: ctx.userId,
      })
      .returning({ id: subscriptionAmendments.id });
    await writeCopsAudit(tx, {
      tenantId: ctx.workspaceId,
      actor: { type: "user", id: ctx.userId },
      entityType: "subscription",
      entityId: sub.id,
      action: "subscription.amended",
      before,
      after: { ...after, amendment_id: row!.id, effective_at: effectiveAt.toISOString() },
      reason: input.reason,
      correlationId: ctx.requestId,
      sourceChannel: "api",
    });
  });
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId)).limit(1);
  return loadDto(db, row!, now);
}
