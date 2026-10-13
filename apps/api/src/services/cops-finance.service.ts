import { and, desc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";

/**
 * COPS-08 Finance read APIs (Bible p.67). Nothing here writes. The reconciliation queue lists the
 * places where what a provider told us and what Skout holds disagree, so a person can settle them;
 * it is built only from tables this service owns.
 */
const { paymentRequests, paymentProviderEvents, subscriptionInvoices, subscriptions, signatureEnvelopes, contracts } = schema;

export type ReconciliationKind = "payment_event_not_applied" | "bill_paid_at_provider_open_here" | "envelope_contract_mismatch" | "envelope_never_confirmed";

export interface ReconciliationIssue {
  kind: ReconciliationKind;
  entity_type: "payment_provider_event" | "subscription_invoice" | "signature_envelope";
  entity_id: string;
  /** What the provider says and what Skout holds. */
  provider_state: string;
  skout_state: string;
  detail: string;
  since: string;
}

const STUCK_ENVELOPE_MINUTES = 15;

export async function loadReconciliation(db: Db, workspaceId: string, now: Date = new Date()): Promise<{ generated_at: string; counts: Record<ReconciliationKind, number>; issues: ReconciliationIssue[] }> {
  const issues: ReconciliationIssue[] = [];

  // A payment webhook that reached us and was not applied to a payment request.
  const events = await db
    .select()
    .from(paymentProviderEvents)
    .where(and(eq(paymentProviderEvents.workspaceId, workspaceId), inArray(paymentProviderEvents.outcome, ["received", "unmatched"]), gte(paymentProviderEvents.receivedAt, new Date(now.getTime() - 30 * 86_400_000))))
    .orderBy(desc(paymentProviderEvents.receivedAt))
    .limit(200);
  for (const e of events) {
    issues.push({
      kind: "payment_event_not_applied",
      entity_type: "payment_provider_event",
      entity_id: e.id,
      provider_state: e.eventType,
      skout_state: e.outcome,
      detail: `${e.provider} event ${e.providerEventId} was received and not applied`,
      since: e.receivedAt.toISOString(),
    });
  }

  // The customer paid the link, and the subscription bill still reads open (the billing pass has not caught up, or is failing).
  const bills = await db
    .select({ id: subscriptionInvoices.id, subscriptionId: subscriptionInvoices.subscriptionId, paidAt: paymentRequests.paidAt, requestId: paymentRequests.id })
    .from(subscriptionInvoices)
    .innerJoin(paymentRequests, eq(paymentRequests.id, subscriptionInvoices.paymentRequestId))
    .where(and(eq(subscriptionInvoices.workspaceId, workspaceId), eq(subscriptionInvoices.status, "open"), eq(paymentRequests.status, "paid")))
    .limit(200);
  for (const b of bills) {
    issues.push({
      kind: "bill_paid_at_provider_open_here",
      entity_type: "subscription_invoice",
      entity_id: b.id,
      provider_state: "paid",
      skout_state: "open",
      detail: `Payment request ${b.requestId} is paid; the bill of subscription ${b.subscriptionId} is still open`,
      since: (b.paidAt ?? now).toISOString(),
    });
  }

  // The e-sign provider and the contract disagree about the version that is current.
  const envelopes = await db
    .select({ id: signatureEnvelopes.id, envelopeStatus: signatureEnvelopes.status, contractId: contracts.id, contractStatus: contracts.status, at: signatureEnvelopes.statusChangedAt, provider: signatureEnvelopes.provider })
    .from(signatureEnvelopes)
    .innerJoin(contracts, and(eq(contracts.id, signatureEnvelopes.contractId), eq(contracts.currentVersion, signatureEnvelopes.contractVersion)))
    .where(and(eq(signatureEnvelopes.workspaceId, workspaceId), inArray(signatureEnvelopes.status, ["signed", "declined", "expired"]), ne(contracts.status, signatureEnvelopes.status)))
    .limit(200);
  for (const e of envelopes) {
    issues.push({
      kind: "envelope_contract_mismatch",
      entity_type: "signature_envelope",
      entity_id: e.id,
      provider_state: e.envelopeStatus,
      skout_state: e.contractStatus,
      detail: `${e.provider} says the envelope is ${e.envelopeStatus}; contract ${e.contractId} is ${e.contractStatus}`,
      since: e.at.toISOString(),
    });
  }

  // We asked the provider to send and never recorded that it did.
  const stuck = await db
    .select({ id: signatureEnvelopes.id, contractId: signatureEnvelopes.contractId, createdAt: signatureEnvelopes.createdAt, provider: signatureEnvelopes.provider })
    .from(signatureEnvelopes)
    .where(and(eq(signatureEnvelopes.workspaceId, workspaceId), eq(signatureEnvelopes.status, "pending_send"), lte(signatureEnvelopes.createdAt, new Date(now.getTime() - STUCK_ENVELOPE_MINUTES * 60_000))))
    .limit(200);
  for (const e of stuck) {
    issues.push({
      kind: "envelope_never_confirmed",
      entity_type: "signature_envelope",
      entity_id: e.id,
      provider_state: "unknown",
      skout_state: "pending_send",
      detail: `The envelope for contract ${e.contractId} has waited over ${STUCK_ENVELOPE_MINUTES} minutes for ${e.provider} to confirm it`,
      since: e.createdAt.toISOString(),
    });
  }

  const counts = { payment_event_not_applied: 0, bill_paid_at_provider_open_here: 0, envelope_contract_mismatch: 0, envelope_never_confirmed: 0 } as Record<ReconciliationKind, number>;
  for (const issue of issues) counts[issue.kind] += 1;
  return { generated_at: now.toISOString(), counts, issues: issues.sort((a, b) => a.since.localeCompare(b.since)) };
}

/** Subscription state and upcoming renewals, soonest renewal first. */
export async function listSubscriptionsForFinance(db: Db, workspaceId: string, where: { status?: string; renewing_within_days?: number } = {}, now: Date = new Date()) {
  const rows = await db
    .select({
      id: subscriptions.id,
      account_id: subscriptions.accountId,
      opportunity_id: subscriptions.opportunityId,
      status: subscriptions.status,
      billing: subscriptions.billing,
      currency: subscriptions.currency,
      cadence: subscriptions.cadence,
      term_months: subscriptions.termMonths,
      renews_at: subscriptions.termEnd,
      renewal_opportunity_id: subscriptions.renewalOpportunityId,
      /** Seats on the original items; amendments are on the subscription itself. */
      // Table-qualified by hand: a single-table select renders bare column names, and a bare "id" inside the subquery would be the item's own.
      seats: sql<number>`coalesce((select sum(i.quantity) from subscription_items i where i.subscription_id = "subscriptions"."id" and i.kind = 'seats'), 0)::int`,
    })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.workspaceId, workspaceId),
        where.status ? eq(subscriptions.status, where.status) : undefined,
        where.renewing_within_days ? and(ne(subscriptions.status, "closed"), lte(subscriptions.termEnd, new Date(now.getTime() + where.renewing_within_days * 86_400_000))) : undefined
      )
    )
    .orderBy(subscriptions.termEnd)
    .limit(500);
  return rows.map((r) => ({ ...r, renews_at: r.renews_at.toISOString() }));
}
