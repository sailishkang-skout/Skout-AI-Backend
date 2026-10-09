import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { appendCopsEvent, createCopsEvent, nextPaymentStatus, type PaymentRequestStatus } from "@skout/shared";
import { createLogger } from "@skout/observability";
import { writeCopsAudit } from "./cops-platform.service.js";
import { advanceCommercialState, CommercialError, getOpportunity, type CommercialContext } from "./cops-commercial.service.js";
import type { PspAdapter } from "./psp/psp-adapter.js";
import { PspRequestError } from "./psp/razorpay.js";

const log = createLogger("cops-payments.service");
const { paymentRequests, paymentProviderEvents, proposals, proposalVersions } = schema;

/** Runs inside the payment transaction after a payment is confirmed (used by the provisioning gate). */
export type OnPaymentChange = (tx: Db, input: { workspaceId: string; opportunityId: string; requestId: string }) => Promise<void>;

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
    // Amount defaults to the total of the proposal's latest sent version.
    const [sent] = await db
      .select({ total: proposalVersions.totalMinor, currency: proposalVersions.currency, status: proposals.status })
      .from(proposals)
      .innerJoin(proposalVersions, eq(proposalVersions.proposalId, proposals.id))
      .where(
        and(
          eq(proposals.id, input.proposal_id),
          eq(proposals.workspaceId, ctx.workspaceId),
          eq(proposals.opportunityId, opportunity.id)
        )
      )
      .orderBy(desc(proposalVersions.sentAt))
      .limit(1);
    if (!sent) {
      throw new CommercialError("VALIDATION_FAILED", "proposal_id is not a proposal of this opportunity", {
        fields: [{ path: "proposal_id", code: "invalid", message: "Not a proposal of this opportunity" }],
      });
    }
    if (!["sent", "accepted"].includes(sent.status)) {
      throw new CommercialError("BUSINESS_STATE_CONFLICT", "Send the proposal before requesting payment for it", { status: sent.status });
    }
    amountMinor ??= Number(sent.total);
    currency ??= sent.currency;
  }
  currency ??= opportunity.currency;
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
      log.warn("payment link create failed", { workspaceId: ctx.workspaceId, status: error.providerStatus });
      throw new CommercialError("PROVIDER_ERROR", "The payment provider rejected the request", {
        provider_status: error.providerStatus,
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
 * `onPaid` (gate evaluation) in the same transaction.
 */
export async function handlePaymentWebhook(
  db: Db,
  psp: PspAdapter,
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
  onPaid?: OnPaymentChange
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
