import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { appendCopsEvent, createCopsEvent, firstInvoiceMinor, nextPaymentStatus, type PaymentRequestStatus } from "@skout/shared";
import { createLogger } from "@skout/observability";
import { writeCopsAudit } from "./cops-platform.service.js";
import { advanceCommercialState, CommercialError, getOpportunity, type CommercialContext } from "./cops-commercial.service.js";
import type { PspAdapter } from "./psp/psp-adapter.js";
import { PspRequestError } from "./psp/razorpay.js";

const log = createLogger("cops-payments.service");
const { paymentRequests, paymentProviderEvents, proposals, proposalVersions, proposalLineItems } = schema;

/** Runs inside the payment transaction after a payment is confirmed (used by the provisioning gate). */
export type OnPaymentChange = (tx: Db, input: { workspaceId: string; opportunityId: string; requestId: string; paymentRequestId?: string }) => Promise<void>;

export interface CreatePaymentRequestInput {
  opportunity_id: string;
  proposal_id?: string;
  amount_minor?: number;
  currency?: string;
  description?: string;
  customer?: { name?: string; email?: string; contact?: string };
  expires_at?: string;
}

/**
 * Create a provider-hosted payment link and record it. The provider call happens before the
 * transaction (it cannot be rolled back); the route's Idempotency-Key stops a retry from creating
 * a second link.
 */
export async function createPaymentRequest(db: Db, psp: PspAdapter, ctx: CommercialContext, input: CreatePaymentRequestInput) {
  if (!psp.isConfigured()) {
    throw new CommercialError("PROVIDER_UNAVAILABLE", "The payment provider is not configured for this environment");
  }
  const opportunity = await getOpportunity(db, ctx.workspaceId, input.opportunity_id);

  let amountMinor = input.amount_minor;
  let currency = input.currency;
  if (input.proposal_id) {
    // The amount is the total of the proposal's latest sent version: what the customer agreed to.
    const [sent] = await db
      .select({
        versionId: proposalVersions.id,
        currency: proposalVersions.currency,
        status: proposals.status,
        cadence: proposalVersions.billingCadence,
        termMonths: proposalVersions.termMonths,
        discountPct: proposalVersions.discountPct,
        taxPct: proposalVersions.taxPct,
        sentAt: proposalVersions.sentAt,
      })
      .from(proposals)
      .innerJoin(proposalVersions, eq(proposalVersions.proposalId, proposals.id))
      .where(
        and(
          eq(proposals.id, input.proposal_id),
          eq(proposals.workspaceId, ctx.workspaceId),
          eq(proposals.opportunityId, opportunity.id),
          isNotNull(proposalVersions.sentAt)
        )
      )
      .orderBy(desc(proposalVersions.sentAt))
      .limit(1);
    if (!sent) {
      const [exists] = await db
        .select({ id: proposals.id })
        .from(proposals)
        .where(and(eq(proposals.id, input.proposal_id), eq(proposals.workspaceId, ctx.workspaceId), eq(proposals.opportunityId, opportunity.id)))
        .limit(1);
      if (exists) throw new CommercialError("BUSINESS_STATE_CONFLICT", "Send the proposal before requesting payment for it", { status: "draft" });
      throw new CommercialError("VALIDATION_FAILED", "proposal_id is not a proposal of this opportunity", {
        fields: [{ path: "proposal_id", code: "invalid", message: "Not a proposal of this opportunity" }],
      });
    }
    if (!["sent", "accepted"].includes(sent.status)) {
      throw new CommercialError("BUSINESS_STATE_CONFLICT", "Send the proposal before requesting payment for it", { status: sent.status });
    }
    // The first invoice of the sent version: a year up front on annual billing, one month on monthly.
    const lines = await db
      .select({ kind: proposalLineItems.kind, priceBasis: proposalLineItems.priceBasis, netMinor: proposalLineItems.netMinor })
      .from(proposalLineItems)
      .where(eq(proposalLineItems.versionId, sent.versionId));
    const due = firstInvoiceMinor({
      billing_cadence: sent.cadence,
      term_months: sent.termMonths,
      discount_pct: Number(sent.discountPct),
      tax_pct: Number(sent.taxPct),
      lines: lines.map((l) => ({ kind: l.kind, price_basis: l.priceBasis, net_minor: Number(l.netMinor) })),
    });
    // A link for a proposal charges exactly its price; a different amount or currency is refused.
    if ((input.amount_minor !== undefined && input.amount_minor !== due) || (input.currency !== undefined && input.currency !== sent.currency)) {
      throw new CommercialError("VALIDATION_FAILED", "A payment link for a proposal charges its sent price; the amount cannot be changed", {
        fields: [{ path: "amount_minor", code: "locked", message: `Must be the proposal's first invoice (${due} ${sent.currency})` }],
      });
    }
    amountMinor = due;
    currency = sent.currency;
    // One payment per proposal, so a customer is never charged twice: no new link once any version
    // was paid (later changes go through a subscription amendment, which prorates), and none while
    // an older link can still be paid (cancel it first).
    const earlier = await db
      .select({ id: paymentRequests.id, status: paymentRequests.status, checkoutUrl: paymentRequests.checkoutUrl, expiresAt: paymentRequests.expiresAt })
      .from(paymentRequests)
      .where(and(eq(paymentRequests.workspaceId, ctx.workspaceId), eq(paymentRequests.proposalId, input.proposal_id), inArray(paymentRequests.status, ["paid", "requested"])));
    const paid = earlier.find((r) => r.status === "paid");
    if (paid) {
      throw new CommercialError("BUSINESS_STATE_CONFLICT", "This proposal is already paid, so it cannot be charged again. To change the price or seats, amend the subscription in Finance.", { payment_request_id: paid.id, status: "paid" });
    }
    const openLink = earlier.find((r) => r.status === "requested" && (!r.expiresAt || r.expiresAt > new Date()));
    if (openLink) {
      throw new CommercialError("BUSINESS_STATE_CONFLICT", "A payment link for this proposal is still open. Copy or email it, or cancel it before making a new one.", {
        payment_request_id: openLink.id,
        checkout_url: openLink.checkoutUrl,
        status: "requested",
      });
    }
  }
  currency ??= opportunity.currency;
  // International checkout stays off until the account can accept it (Razorpay KYC).
  if (psp.supportsCurrency && !psp.supportsCurrency(currency)) {
    throw new CommercialError("BUSINESS_STATE_CONFLICT", `International payments are not enabled yet, so a ${currency} payment link cannot be made. Use INR, or ask Finance.`, { currency });
  }
  if (!amountMinor || amountMinor < 100) {
    throw new CommercialError("VALIDATION_FAILED", "amount_minor is required (at least 100 minor units)", {
      fields: [{ path: "amount_minor", code: "required", message: "Required unless proposal_id is given" }],
    });
  }
  const expiresAt = input.expires_at ? new Date(input.expires_at) : undefined;
  if (expiresAt && expiresAt.getTime() < Date.now() + 15 * 60_000) {
    throw new CommercialError("VALIDATION_FAILED", "expires_at must be at least 15 minutes in the future", {
      fields: [{ path: "expires_at", code: "too_soon", message: "At least 15 minutes ahead" }],
    });
  }

  const id = randomUUID();
  const description = input.description?.trim() || `Payment for ${opportunity.name}`;
  let link;
  try {
    link = await psp.createPaymentLink({
      amountMinor,
      currency,
      description,
      referenceId: id,
      customer: input.customer,
      expiresAt,
      notes: { payment_request_id: id, workspace_id: ctx.workspaceId, opportunity_id: opportunity.id },
    });
  } catch (error) {
    if (error instanceof PspRequestError) {
      // Razorpay answers {"error":{"code","description"}}; its description says why (for example
      // international cards or a currency not enabled on the account, or bad API keys).
      let reason = "";
      try {
        reason = String((JSON.parse(error.providerMessage) as { error?: { description?: unknown } }).error?.description ?? "");
      } catch {
        reason = "";
      }
      if (error.providerStatus === 401) reason = "the payment provider's API keys were refused";
      log.warn("payment link create failed", { workspaceId: ctx.workspaceId, status: error.providerStatus, reason: reason || error.providerMessage.slice(0, 200) });
      throw new CommercialError("PROVIDER_ERROR", reason ? `The payment provider rejected the request: ${reason}` : "The payment provider rejected the request", {
        provider_status: error.providerStatus,
        ...(reason ? { provider_reason: reason } : {}),
      });
    }
    throw error;
  }

  await db.transaction(async (tx) => {
    await tx.insert(paymentRequests).values({
      id,
      workspaceId: ctx.workspaceId,
      opportunityId: opportunity.id,
      proposalId: input.proposal_id ?? null,
      amountMinor,
      currency: currency!,
      description,
      status: "requested",
      provider: psp.provider,
      providerRef: link.providerRef,
      checkoutUrl: link.checkoutUrl,
      expiresAt: expiresAt ?? null,
      createdBy: ctx.userId,
    });
    await writeCopsAudit(tx, {
      tenantId: ctx.workspaceId,
      actor: { type: "user", id: ctx.userId },
      entityType: "payment_request",
      entityId: id,
      action: "payment_request.created",
      after: { opportunity_id: opportunity.id, amount_minor: amountMinor, currency, provider: psp.provider, provider_ref: link.providerRef },
      correlationId: ctx.requestId,
      sourceChannel: "api",
    });
    await appendCopsEvent(
      tx as never,
      createCopsEvent({
        eventType: "PaymentRequested",
        tenantId: ctx.workspaceId,
        aggregateType: "payment_request",
        aggregateId: id,
        actor: { type: "user", id: ctx.userId },
        correlationId: ctx.requestId,
        payload: { payment_request_id: id, opportunity_id: opportunity.id },
      })
    );
    await advanceCommercialState(tx as unknown as Db, {
      workspaceId: ctx.workspaceId,
      opportunityId: opportunity.id,
      to: "payment_pending",
      actorId: ctx.userId,
      reason: "Payment link created",
      requestId: ctx.requestId,
    });
  });
  return id;
}

export type WebhookOutcome =
  | { kind: "unauthorized" }
  | { kind: "bad_request" }
  | { kind: "duplicate" }
  | { kind: "processed"; outcome: "applied" | "ignored" | "unmatched"; status?: PaymentRequestStatus };

/**
 * Provider webhook. Signature first (401 otherwise); then, in one transaction, the event id is
 * recorded (unique per provider, so a replay or a concurrent duplicate stops here), the payment
 * request is locked and its status moves forward only. A paid event emits PaymentSucceeded and runs
 * `onPaid` (gate evaluation) in the same transaction; a refunded event runs `onRefunded` (credit
 * purchase reversal) in the same transaction.
 */
export async function handlePaymentWebhook(
  db: Db,
  psp: PspAdapter,
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
  onPaid?: OnPaymentChange,
  onRefunded?: OnPaymentChange
): Promise<WebhookOutcome> {
  if (!psp.verifyWebhook(rawBody, headers)) return { kind: "unauthorized" };
  const event = psp.parseWebhook(rawBody, headers);
  if (!event) return { kind: "bad_request" };
  const requestId = randomUUID();

  return db.transaction(async (tx) => {
    const [recorded] = await tx
      .insert(paymentProviderEvents)
      .values({ provider: psp.provider, providerEventId: event.eventId, eventType: event.eventType, outcome: "received", refs: event.refs, providerCreatedAt: event.providerCreatedAt ?? null })
      .onConflictDoNothing()
      .returning({ id: paymentProviderEvents.id });
    if (!recorded) return { kind: "duplicate" } as const;

    // Most specific identifier first: the payment link id, then our own id from the notes, then the
    // provider payment id (refunds carry only that). One identifier is used, never an OR of several,
    // so an event can only ever land on the request it names.
    const matcher = event.providerRef
      ? eq(paymentRequests.providerRef, event.providerRef)
      : event.referenceId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(event.referenceId)
        ? eq(paymentRequests.id, event.referenceId)
        : event.paymentId
          ? eq(paymentRequests.providerPaymentId, event.paymentId)
          : null;
    const [request] = matcher
      ? await tx
          .select()
          .from(paymentRequests)
          .where(and(eq(paymentRequests.provider, psp.provider), matcher))
          .for("update")
          .limit(1)
      : [];

    const finish = async (outcome: "applied" | "ignored" | "unmatched", status?: PaymentRequestStatus) => {
      await tx
        .update(paymentProviderEvents)
        // clock_timestamp(), not now(): now() is the transaction start, which is also received_at.
        .set({ outcome, workspaceId: request?.workspaceId ?? null, paymentRequestId: request?.id ?? null, processedAt: sql`clock_timestamp()` })
        .where(eq(paymentProviderEvents.id, recorded.id));
      return { kind: "processed", outcome, status } as const;
    };

    if (!request) {
      log.warn("payment webhook matched no payment request", { eventType: event.eventType, eventId: event.eventId });
      return finish("unmatched");
    }
    const next = event.status ? nextPaymentStatus(request.status as PaymentRequestStatus, event.status) : null;
    if (!next) return finish("ignored", request.status as PaymentRequestStatus);

    const at = new Date();
    await tx
      .update(paymentRequests)
      .set({
        status: next,
        statusChangedAt: at,
        updatedAt: at,
        ...(next === "paid" ? { paidAt: at, providerPaymentId: event.paymentId ?? request.providerPaymentId } : {}),
      })
      .where(eq(paymentRequests.id, request.id));
    await writeCopsAudit(tx, {
      tenantId: request.workspaceId,
      actor: { type: "integration", id: psp.provider },
      entityType: "payment_request",
      entityId: request.id,
      action: `payment_request.${next}`,
      before: { status: request.status },
      after: { status: next, provider_event_id: event.eventId, provider_payment_id: event.paymentId },
      correlationId: requestId,
      sourceChannel: "webhook",
      occurredAt: at,
    });
    if (next === "paid") {
      await appendCopsEvent(
        tx as never,
        createCopsEvent({
          eventType: "PaymentSucceeded",
          tenantId: request.workspaceId,
          aggregateType: "payment_request",
          aggregateId: request.id,
          actor: { type: "integration", id: psp.provider },
          correlationId: requestId,
          payload: { payment_request_id: request.id, opportunity_id: request.opportunityId },
          occurredAt: at,
        })
      );
      if (onPaid) await onPaid(tx as unknown as Db, { workspaceId: request.workspaceId, opportunityId: request.opportunityId, requestId });
    }
    if (next === "refunded" && onRefunded) {
      await onRefunded(tx as unknown as Db, { workspaceId: request.workspaceId, opportunityId: request.opportunityId, requestId, paymentRequestId: request.id });
    }
    return finish("applied", next);
  });
}

export async function loadPaymentRequests(db: Db, workspaceId: string, where: { id?: string; opportunityIds?: string[] }) {
  if (where.opportunityIds && where.opportunityIds.length === 0) return [];
  const rows = await db
    .select()
    .from(paymentRequests)
    .where(
      and(
        eq(paymentRequests.workspaceId, workspaceId),
        where.id ? eq(paymentRequests.id, where.id) : undefined,
        where.opportunityIds ? inArray(paymentRequests.opportunityId, where.opportunityIds) : undefined
      )
    )
    .orderBy(desc(paymentRequests.createdAt));
  return rows.map((r) => ({
    id: r.id,
    opportunity_id: r.opportunityId,
    proposal_id: r.proposalId,
    amount_minor: Number(r.amountMinor),
    currency: r.currency,
    description: r.description,
    status: r.status,
    provider: r.provider,
    provider_ref: r.providerRef,
    checkout_url: r.checkoutUrl,
    paid_at: r.paidAt?.toISOString() ?? null,
    expires_at: r.expiresAt?.toISOString() ?? null,
    status_changed_at: r.statusChangedAt?.toISOString() ?? null,
    created_at: r.createdAt.toISOString(),
  }));
}

/** Cancels an unpaid link at the provider and here, so it can no longer be paid. */
export async function cancelPaymentRequest(db: Db, psp: PspAdapter, ctx: CommercialContext, id: string, reason: string): Promise<void> {
  const [pr] = await db.select().from(paymentRequests).where(and(eq(paymentRequests.workspaceId, ctx.workspaceId), eq(paymentRequests.id, id))).limit(1);
  if (!pr) throw new CommercialError("NOT_FOUND", "Payment request not found");
  if (pr.status !== "requested") {
    throw new CommercialError("BUSINESS_STATE_CONFLICT", `Only an unpaid link can be cancelled; this one is ${pr.status}`, { status: pr.status });
  }
  if (pr.providerRef && psp.cancelPaymentLink) {
    try {
      await psp.cancelPaymentLink(pr.providerRef);
    } catch (error) {
      if (error instanceof PspRequestError) {
        throw new CommercialError("PROVIDER_ERROR", "The payment provider did not cancel the link, so it may still be payable. Try again.", { provider_status: error.providerStatus });
      }
      throw error;
    }
  }
  const at = new Date();
  await db.transaction(async (tx) => {
    await tx.update(paymentRequests).set({ status: "cancelled", statusChangedAt: at, updatedAt: at }).where(eq(paymentRequests.id, id));
    await writeCopsAudit(tx, {
      tenantId: ctx.workspaceId,
      actor: { type: "user", id: ctx.userId },
      entityType: "payment_request",
      entityId: id,
      action: "payment_request.cancelled",
      before: { status: "requested" },
      after: { status: "cancelled", reason },
      correlationId: ctx.requestId,
      sourceChannel: "api",
    });
  });
}

/**
 * Refunds a paid link in full at the provider, then marks it refunded here and runs the same
 * follow-up as a provider "refunded" event (credits it bought are taken back). The provider's own
 * refunded webhook arriving later changes nothing.
 */
export async function refundPaymentRequest(db: Db, psp: PspAdapter, ctx: CommercialContext, id: string, reason: string, onRefunded?: OnPaymentChange): Promise<void> {
  const [pr] = await db.select().from(paymentRequests).where(and(eq(paymentRequests.workspaceId, ctx.workspaceId), eq(paymentRequests.id, id))).limit(1);
  if (!pr) throw new CommercialError("NOT_FOUND", "Payment request not found");
  if (pr.status !== "paid") throw new CommercialError("BUSINESS_STATE_CONFLICT", `Only a paid link can be refunded; this one is ${pr.status}`, { status: pr.status });
  if (!pr.providerPaymentId || !psp.refundPayment) {
    throw new CommercialError("BUSINESS_STATE_CONFLICT", "The provider's payment id is missing, so this refund has to be made in the provider's dashboard", {});
  }
  let refundId: string;
  try {
    ({ refundId } = await psp.refundPayment(pr.providerPaymentId, Number(pr.amountMinor), { payment_request_id: pr.id, reason: reason.slice(0, 200) }));
  } catch (error) {
    if (error instanceof PspRequestError) {
      // Razorpay's description alone is often generic ("invalid request sent"); reason and field say why.
      let why = "";
      let reason: string | null = null;
      try {
        const e = (JSON.parse(error.providerMessage) as { error?: { description?: unknown; reason?: unknown; field?: unknown; code?: unknown } }).error ?? {};
        reason = [e.reason, e.field].filter((x) => typeof x === "string" && x && x !== "NA").join(" / ") || null;
        why = [String(e.description ?? ""), reason ? `(${reason})` : ""].filter(Boolean).join(" ");
      } catch {
        why = "";
      }
      // A refund moves money: never retried automatically, whatever the provider answered.
      throw new CommercialError("PROVIDER_ERROR", why ? `The payment provider did not refund: ${why}` : "The payment provider did not refund this payment", { provider_status: error.providerStatus, provider_reason: reason, no_retry: true });
    }
    throw error;
  }
  const at = new Date();
  await db.transaction(async (tx) => {
    await tx.update(paymentRequests).set({ status: "refunded", statusChangedAt: at, updatedAt: at }).where(eq(paymentRequests.id, pr.id));
    await writeCopsAudit(tx, {
      tenantId: ctx.workspaceId,
      actor: { type: "user", id: ctx.userId },
      entityType: "payment_request",
      entityId: pr.id,
      action: "payment_request.refunded",
      before: { status: "paid" },
      after: { status: "refunded", amount_minor: Number(pr.amountMinor), currency: pr.currency, provider_refund_id: refundId, reason },
      correlationId: ctx.requestId,
      sourceChannel: "api",
    });
    if (onRefunded) await onRefunded(tx as unknown as Db, { workspaceId: pr.workspaceId, opportunityId: pr.opportunityId, requestId: ctx.requestId, paymentRequestId: pr.id });
  });
}
