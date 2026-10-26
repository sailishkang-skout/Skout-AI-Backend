import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { schema, type Db } from "@skout/db";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

/**
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md (COPS-03 additions).
 *   - Tables touched directly: deals - read only (opportunity name, amount, currency, deal type, status and
 *     company for the Commercial Desk list and the payment webhook); companies - read only (account name on
 *     the cross-account Commercial Desk) (owned by apps/crm)
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: the Commercial Desk lists opportunities next to their proposals, contracts and gate in one
 *     query, and the payment webhook resolves the account inside its own transaction.
 *   - Review date: revisit when apps/crm's internal API covers batched reads
 */
import { APPROVER_ROLES, REDLINE_STATUSES, PRICE_BASES, SUBSCRIPTION_BILLING, SUBSCRIPTION_CADENCES, BILLING_CADENCES, COMMERCIAL_GATE_POLICIES, COMMERCIAL_LINE_KINDS, copsErrorBody, copsErrorStatus, resolveCorrelationId } from "@skout/shared";
import { getMemberPermissions } from "@skout/auth";
import { copsIdempotencyStore, requireAnyCopsPermission } from "../services/cops-platform.service.js";
import { withCopsIdempotentReply, type CopsCapturingReply } from "../services/cops-idempotent.js";
import {
  addContractVersion,
  attachNegotiatedVersion,
  addProposalVersion,
  CommercialError,
  createContract,
  createProposal,
  getOpportunity,
  loadContracts,
  loadProposals,
  sendContract,
  sendProposal,
  setContractStatus,
  setProposalStatus,
  discardDraftProposal,
  discardDraftContract,
  type CommercialContext,
} from "../services/cops-commercial.service.js";
import { createPaymentRequest, handlePaymentWebhook, loadPaymentRequests } from "../services/cops-payments.service.js";
import { assertApproved, assertContractApproved, decideApproval, evaluateProposalApprovals, listApprovals, requestApproval } from "../services/cops-approvals.service.js";
import { createRazorpayPaymentLinkAdapter } from "../services/psp/razorpay.js";
import {
  approveTrial,
  evaluateGate,
  getGate,
  listGatePolicies,
  overrideGate,
  setDealType,
  setGatePolicy,
} from "../services/cops-gate.service.js";
import type { PspAdapter } from "../services/psp/psp-adapter.js";
import { createMockEsignAdapter, type EsignAdapter } from "../services/esign/esign-adapter.js";
import { createDocusealAdapter } from "../services/esign/docuseal-adapter.js";
import { handleEsignWebhook, listEnvelopes, sendEnvelope } from "../services/cops-esign.service.js";
import { resolveContractDocumentForProvider } from "./cops-contract-documents.routes.js";
import { getAccountContractFields, setAccountContractFields } from "../services/cops-account-fields.service.js";
import { CREDIT_ACTIVITY_KINDS, listCreditActivity, listSubscriptionsForFinance, loadReconciliation } from "../services/cops-finance.service.js";
import { amendSubscription, createSubscription, getAccountSubscription, issueInvoicePaymentLink, listFailedPayments, markInvoicePaid } from "../services/cops-subscriptions.service.js";
import { applyPaidCreditPurchases, reverseRefundedCreditPurchase } from "../services/cops-credits.service.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const pct = z.number().min(0).max(100).multipleOf(0.01);
const lineItemSchema = z
  .object({
    kind: z.enum(COMMERCIAL_LINE_KINDS),
    description: z.string().trim().min(1).max(500),
    quantity: z.number().int().min(1).max(10_000_000),
    unit_amount_minor: z.number().int().min(0).max(1_000_000_000_000),
    discount_pct: pct.default(0),
    price_basis: z.enum(PRICE_BASES).optional(),
  })
  .strict();
const termsSchema = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/, "currency must be an ISO 4217 code"),
    billing_cadence: z.enum(BILLING_CADENCES),
    term_months: z.number().int().min(1).max(120),
    discount_pct: pct.default(0),
    tax_pct: pct.default(0),
    notes: z.string().max(5000).nullable().optional(),
    payment_terms_net_days: z.number().int().min(0).max(365).optional(),
    free_credits: z.number().int().min(0).max(10_000_000).optional(),
    custom_clauses: z.boolean().optional(),
    non_standard_sla: z.boolean().optional(),
    line_items: z.array(lineItemSchema).min(1).max(200),
  })
  .strict();
const createProposalSchema = termsSchema.extend({ title: z.string().trim().min(1).max(200) }).strict();
const sendSchema = z
  .object({ recipient_contact_ids: z.array(z.string().regex(UUID)).max(50).optional(), message: z.string().max(5000).optional() })
  .strict();
const reasonText = z.string().trim().min(1, "reason is required").max(1000);
const proposalStatusSchema = z.object({ status: z.enum(["accepted", "declined", "expired"]), reason: reasonText }).strict();
const discardSchema = z.object({ reason: reasonText }).strict();
const documentSchema = z
  .object({
    document_url: z.string().trim().min(1).max(2000),
    file_name: z.string().trim().max(300).optional(),
    file_sha256: z.string().regex(/^[a-f0-9]{64}$/, "file_sha256 must be a lowercase hex SHA-256"),
  })
  .strict();
const negotiatedVersionSchema = documentSchema.extend({ redline_status: z.enum(REDLINE_STATUSES), note: z.string().trim().max(1000).optional() }).strict();
const createContractSchema = documentSchema
  .extend({
    kind: z.enum(["msa", "order_form", "dpa"]),
    title: z.string().trim().max(200).optional(),
    proposal_id: z.string().regex(UUID).optional(),
  })
  .strict();
const paymentRequestSchema = z
  .object({
    opportunity_id: z.string().regex(UUID, "Invalid id"),
    proposal_id: z.string().regex(UUID, "Invalid id").optional(),
    amount_minor: z.number().int().min(100).max(1_000_000_000_000).optional(),
    currency: z.string().regex(/^[A-Z]{3}$/, "currency must be an ISO 4217 code").optional(),
    description: z.string().trim().max(2000).optional(),
    customer: z
      .object({ name: z.string().trim().max(200).optional(), email: z.string().email().optional(), contact: z.string().trim().max(20).optional() })
      .strict()
      .optional(),
    expires_at: z.string().datetime().optional(),
  })
  .strict();
const gateReasonSchema = z.object({ reason: reasonText }).strict();
const gatePolicySchema = z
  .object({ deal_type: z.string().trim().min(1).max(64), policy: z.enum(COMMERCIAL_GATE_POLICIES) })
  .strict();
const dealTypeSchema = z
  .object({
    deal_type: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .refine((v) => v !== "*", "The value * is reserved for the workspace default"),
  })
  .strict();
const contractStatusSchema = z
  .object({ status: z.enum(["signed", "declined", "expired"]), reason: reasonText, signed_at: z.string().datetime().optional() })
  .strict();

const envelopeSchema = z
  .object({
    signers: z
      .array(z.object({ name: z.string().trim().min(1).max(200), email: z.string().trim().email().max(320), role: z.string().trim().max(100).optional() }).strict())
      .min(1)
      .max(10),
    merge_fields: z.record(z.string().regex(/^[a-z0-9_]{1,64}$/), z.string().max(2000)).optional(),
    template_context: z.object({ region: z.string().trim().max(64).optional(), segment: z.string().trim().max(64).optional(), legal_entity: z.string().trim().max(64).optional() }).strict().optional(),
    message: z.string().max(5000).optional(),
  })
  .strict();

const subscriptionSchema = z
  .object({
    opportunity_id: z.string().regex(UUID),
    seats: z.number().int().min(1).max(100_000),
    cadence: z.enum(SUBSCRIPTION_CADENCES),
    term_months: z.number().int().min(1).max(120),
    billing: z.enum(SUBSCRIPTION_BILLING).optional(),
    seat_month_minor: z.number().int().min(1).max(1_000_000_000).optional(),
    payment_terms_net_days: z.number().int().min(0).max(365).optional(),
    start_at: z.string().datetime().optional(),
  })
  .strict();
const amendmentSchema = z
  .object({ seats: z.number().int().min(1).max(100_000).optional(), term_months: z.number().int().min(1).max(120).optional(), reason: z.string().trim().min(1, "reason is required").max(1000) })
  .strict();
const financeSubscriptionsQuery = z
  .object({ status: z.enum(["active", "past_due", "restricted", "suspended", "closed"]).optional(), renewing_within_days: z.coerce.number().int().min(1).max(730).optional() })
  .strict();
const financeCreditQuery = z.object({ kind: z.enum(CREDIT_ACTIVITY_KINDS).optional() }).strict();
const financePaymentsQuery = z.object({ status: z.enum(["requested", "paid", "failed", "expired", "cancelled", "refunded"]).optional() }).strict();
const markPaidSchema = z.object({ reason: z.string().trim().min(1, "reason is required").max(1000) }).strict();

const approvalDecisionSchema = z
  .object({ role: z.enum(APPROVER_ROLES), decision: z.enum(["approved", "rejected"]), comment: z.string().trim().max(2000).nullable().optional() })
  .strict();
const approvalQuerySchema = z
  .object({ status: z.enum(["pending", "approved", "rejected", "voided", "expired"]).optional(), role: z.enum(APPROVER_ROLES).optional() })
  .strict();

type Reply = CopsCapturingReply;

/**
 * COPS-03 proposals and contracts (status-tracking scope). Contract: docs/api/copos-03-commercial.openapi.yaml.
 * Every write needs an Idempotency-Key; reads need commercial:read. Sent versions are immutable.
 */
export async function copsCommercialRoutes(app: FastifyInstance, opts: { db: Db; psp?: PspAdapter; esign?: EsignAdapter }) {
  const { db } = opts;
  // DocuSeal once its API key is in the encrypted env file; the mock (never in production) until then.
  const esign =
    opts.esign ??
    (app.config.DOCUSEAL_API_KEY
      ? createDocusealAdapter({
          apiKey: app.config.DOCUSEAL_API_KEY,
          baseUrl: app.config.DOCUSEAL_BASE_URL,
          webhookSecret: app.config.DOCUSEAL_WEBHOOK_SECRET,
          webhookHeader: app.config.DOCUSEAL_WEBHOOK_HEADER,
        })
      : createMockEsignAdapter({ secret: app.config.ESIGN_MOCK_WEBHOOK_SECRET, enabled: app.config.NODE_ENV !== "production" }));
  const psp = opts.psp ?? createRazorpayPaymentLinkAdapter(app.config);
  const perms = (ws: string, user: string) => getMemberPermissions(db, ws, user);
  const readGate = requireAnyCopsPermission(["commercial:read"], perms);
  const contractReadGate = requireAnyCopsPermission(["commercial:read", "legal:read"], perms);
  const proposalWriteGate = requireAnyCopsPermission(["commercial:send", "commercial:write"], perms);
  const contractWriteGate = requireAnyCopsPermission(["commercial:write", "legal:write", "commercial:send"], perms);
  const sendGate = requireAnyCopsPermission(["commercial:send"], perms);
  const statusGate = requireAnyCopsPermission(["commercial:write", "legal:write"], perms);
  const paymentWriteGate = requireAnyCopsPermission(["commercial:send", "billing:write"], perms);
  const paymentReadGate = requireAnyCopsPermission(["commercial:read", "billing:read"], perms);
  const idempotency = copsIdempotencyStore(db);

  const ctxOf = (request: { workspaceId?: string; userId?: string; headers: Record<string, unknown> }): CommercialContext => ({
    workspaceId: request.workspaceId!,
    userId: request.userId!,
    requestId: resolveCorrelationId(request.headers["x-request-id"] as string | undefined),
  });

  function invalid(reply: Reply, requestId: string, error: z.ZodError | { path: string; message: string }) {
    const fields =
      error instanceof z.ZodError
        ? error.issues.map((i) => ({ path: i.path.join(".") || "body", code: i.code, message: i.message }))
        : [{ path: error.path, code: "invalid", message: error.message }];
    return reply
      .status(copsErrorStatus("VALIDATION_FAILED"))
      .send(copsErrorBody({ code: "VALIDATION_FAILED", message: fields[0]?.message ?? "Invalid request", requestId, details: { fields } }));
  }

  /** Runs a service call and maps CommercialError to the COPS envelope. */
  async function run<T>(reply: Reply, requestId: string, fn: () => Promise<T>, onOk: (value: T) => unknown) {
    try {
      return onOk(await fn());
    } catch (error) {
      if (error instanceof CommercialError) {
        return reply.status(error.status).send(
          copsErrorBody({ code: error.code, message: error.message, requestId, details: error.details, retryable: error.retryable })
        );
      }
      throw error;
    }
  }

  const checkId = (reply: Reply, requestId: string, id: string, path = "id") =>
    UUID.test(id) ? null : invalid(reply, requestId, { path, message: "Invalid id" });

  // ---- Approvals (COPS-08). Contract: docs/api/copos-08-commercial-advanced.openapi.yaml ----

  const approvalDecideGate = requireAnyCopsPermission(["commercial:approve", "legal:approve"], perms);
  type IdOnly = { Params: { id: string }; Body: unknown; Querystring: unknown };

  app.get<IdOnly>("/proposals/:id/approvals/evaluate", { preHandler: readGate }, async (request, reply) => {
    const ctx = ctxOf(request);
    const bad = checkId(reply as unknown as Reply, ctx.requestId, request.params.id);
    if (bad) return bad;
    return run(reply as unknown as Reply, ctx.requestId, () => evaluateProposalApprovals(db, ctx.workspaceId, request.params.id), (data) => ({ data }));
  });

  app.get<IdOnly>("/proposals/:id/approvals", { preHandler: readGate }, async (request, reply) => {
    const ctx = ctxOf(request);
    const bad = checkId(reply as unknown as Reply, ctx.requestId, request.params.id);
    if (bad) return bad;
    return { data: await listApprovals(db, ctx.workspaceId, { proposalId: request.params.id }) };
  });

  app.post<IdOnly>(
    "/proposals/:id/approvals",
    { preHandler: sendGate },
    withCopsIdempotentReply<IdOnly>(idempotency, async (request, reply) => {
      const ctx = ctxOf(request);
      const bad = checkId(reply, ctx.requestId, request.params.id);
      if (bad) return bad;
      return run(reply, ctx.requestId, () => requestApproval(db, ctx, request.params.id), (approval) => reply.status(201).send({ data: approval }));
    })
  );

  app.get<{ Querystring: unknown }>("/approvals", { preHandler: approvalDecideGate }, async (request, reply) => {
    const ctx = ctxOf(request);
    const parsed = approvalQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return invalid(reply as unknown as Reply, ctx.requestId, parsed.error);
    const list = await listApprovals(db, ctx.workspaceId, parsed.data);
    // The approver needs to know which deal this is, not only its numbers.
    const ids = [...new Set(list.map((a) => a.opportunity_id))];
    const named = ids.length
      ? await db
          .select({ id: schema.deals.id, name: schema.deals.name, account: schema.companies.name, accountId: schema.companies.id })
          .from(schema.deals)
          .leftJoin(schema.companies, eq(schema.companies.id, schema.deals.companyId))
          .where(and(eq(schema.deals.workspaceId, ctx.workspaceId), inArray(schema.deals.id, ids)))
      : [];
    const byId = new Map(named.map((n) => [n.id, n]));
    return {
      data: list.map((a) => ({ ...a, opportunity_name: byId.get(a.opportunity_id)?.name ?? null, account_id: byId.get(a.opportunity_id)?.accountId ?? null, account_name: byId.get(a.opportunity_id)?.account ?? null })),
    };
  });

  /** Deals the approval engine skips because they were already sent, signed or paid (report for Finance). */
  const financeReportGate = requireAnyCopsPermission(["commercial:approve", "billing:read"], perms);
  app.get("/approvals/grandfathered", { preHandler: financeReportGate }, async (request) => {
    const ctx = ctxOf(request);
    const rows = await db
      .select({
        opportunity_id: schema.commercialGates.opportunityId,
        opportunity_name: schema.deals.name,
        amount: schema.deals.amount,
        currency: schema.deals.currency,
        grandfathered_at: schema.commercialGates.approvalsGrandfatheredAt,
        reason: schema.commercialGates.approvalsGrandfatheredReason,
      })
      .from(schema.commercialGates)
      .innerJoin(schema.deals, eq(schema.deals.id, schema.commercialGates.opportunityId))
      .where(and(eq(schema.commercialGates.workspaceId, ctx.workspaceId), sql`${schema.commercialGates.approvalsGrandfatheredAt} is not null`))
      .orderBy(desc(schema.commercialGates.approvalsGrandfatheredAt), schema.deals.name)
      .limit(1000);
    return {
      data: rows.map((r) => ({ ...r, amount: r.amount == null ? null : Number(r.amount), grandfathered_at: r.grandfathered_at?.toISOString() ?? null, reasons: (r.reason ?? "").split(",").filter(Boolean) })),
    };
  });

  app.post<IdOnly>(
    "/approvals/:id/decisions",
    { preHandler: approvalDecideGate },
    withCopsIdempotentReply<IdOnly>(idempotency, async (request, reply) => {
      const ctx = ctxOf(request);
      const bad = checkId(reply, ctx.requestId, request.params.id);
      if (bad) return bad;
      const parsed = approvalDecisionSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
      return run(reply, ctx.requestId, () => decideApproval(db, ctx, request.params.id, parsed.data), (approval) => ({ data: approval }));
    })
  );

  // ---- Subscriptions (COPS-08) ----

  const billingWriteGate = requireAnyCopsPermission(["billing:write"], perms);
  const billingReadGate = requireAnyCopsPermission(["billing:read", "commercial:read"], perms);

  app.post<IdOnly>(
    "/accounts/:id/subscription",
    { preHandler: billingWriteGate },
    withCopsIdempotentReply<IdOnly>(idempotency, async (request, reply) => {
      const ctx = ctxOf(request);
      const bad = checkId(reply, ctx.requestId, request.params.id);
      if (bad) return bad;
      const parsed = subscriptionSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
      return run(reply, ctx.requestId, () => createSubscription(db, ctx, request.params.id, parsed.data), (subscription) => reply.status(201).send({ data: subscription }));
    })
  );

  app.get<IdOnly>("/accounts/:id/subscription", { preHandler: billingReadGate }, async (request, reply) => {
    const ctx = ctxOf(request);
    const bad = checkId(reply as unknown as Reply, ctx.requestId, request.params.id);
    if (bad) return bad;
    return { data: await getAccountSubscription(db, ctx.workspaceId, request.params.id) };
  });

  app.post<IdOnly>(
    "/subscriptions/:id/amendments",
    { preHandler: billingWriteGate },
    withCopsIdempotentReply<IdOnly>(idempotency, async (request, reply) => {
      const ctx = ctxOf(request);
      const bad = checkId(reply, ctx.requestId, request.params.id);
      if (bad) return bad;
      const parsed = amendmentSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
      return run(reply, ctx.requestId, () => amendSubscription(db, ctx, request.params.id, parsed.data), (subscription) => reply.status(201).send({ data: subscription }));
    })
  );

  app.post<IdOnly>(
    "/subscription-invoices/:id/payment-link",
    { preHandler: paymentWriteGate },
    withCopsIdempotentReply<IdOnly>(idempotency, async (request, reply) => {
      const ctx = ctxOf(request);
      const bad = checkId(reply, ctx.requestId, request.params.id);
      if (bad) return bad;
      return run(
        reply,
        ctx.requestId,
        async () => {
          const linked = await issueInvoicePaymentLink(db, psp, ctx, request.params.id);
          const [payment] = await loadPaymentRequests(db, ctx.workspaceId, { id: linked.payment_request_id });
          return { ...linked, payment_request: payment };
        },
        (data) => reply.status(201).send({ data })
      );
    })
  );

  app.post<IdOnly>(
    "/subscription-invoices/:id/mark-paid",
    { preHandler: billingWriteGate },
    withCopsIdempotentReply<IdOnly>(idempotency, async (request, reply) => {
      const ctx = ctxOf(request);
      const bad = checkId(reply, ctx.requestId, request.params.id);
      if (bad) return bad;
      const parsed = markPaidSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
      return run(reply, ctx.requestId, () => markInvoicePaid(db, ctx, request.params.id, parsed.data.reason), () => ({ data: { ok: true } }));
    })
  );

  /** Finance: accounts with an unpaid bill past its due date, worst first. */
  app.get("/finance/failed-payments", { preHandler: requireAnyCopsPermission(["billing:read"], perms) }, async (request) => {
    const ctx = ctxOf(request);
    return { data: await listFailedPayments(db, ctx.workspaceId) };
  });

  const financeReadGate = requireAnyCopsPermission(["billing:read"], perms);

  /** Finance: where a provider and Skout disagree. */
  app.get("/finance/reconciliation", { preHandler: financeReadGate }, async (request) => {
    const ctx = ctxOf(request);
    return { data: await loadReconciliation(db, ctx.workspaceId) };
  });

  app.get<{ Querystring: unknown }>("/finance/subscriptions", { preHandler: financeReadGate }, async (request, reply) => {
    const ctx = ctxOf(request);
    const parsed = financeSubscriptionsQuery.safeParse(request.query ?? {});
    if (!parsed.success) return invalid(reply as unknown as Reply, ctx.requestId, parsed.error);
    return { data: await listSubscriptionsForFinance(db, ctx.workspaceId, parsed.data) };
  });

  /** Finance: credit purchases and manual ledger entries across accounts, with actor and reason. */
  app.get<{ Querystring: unknown }>("/finance/credit-activity", { preHandler: requireAnyCopsPermission(["billing:read", "credits:read"], perms) }, async (request, reply) => {
    const ctx = ctxOf(request);
    const parsed = financeCreditQuery.safeParse(request.query ?? {});
    if (!parsed.success) return invalid(reply as unknown as Reply, ctx.requestId, parsed.error);
    const rows = await listCreditActivity(db, ctx.workspaceId, parsed.data);
    const ids = [...new Set(rows.map((r) => r.account_id))];
    const names = ids.length
      ? await db.select({ id: schema.companies.id, name: schema.companies.name }).from(schema.companies).where(and(eq(schema.companies.workspaceId, ctx.workspaceId), inArray(schema.companies.id, ids)))
      : [];
    const byId = new Map(names.map((n) => [n.id, n.name]));
    return { data: rows.map((r) => ({ ...r, account_name: byId.get(r.account_id) ?? null })) };
  });

  /** Finance: payment links across accounts, newest first, with the opportunity they belong to. */
  app.get<{ Querystring: unknown }>("/finance/payment-requests", { preHandler: financeReadGate }, async (request, reply) => {
    const ctx = ctxOf(request);
    const parsed = financePaymentsQuery.safeParse(request.query ?? {});
    if (!parsed.success) return invalid(reply as unknown as Reply, ctx.requestId, parsed.error);
    const rows = await db
      .select({
        id: schema.paymentRequests.id,
        opportunity_id: schema.paymentRequests.opportunityId,
        opportunity_name: schema.deals.name,
        account_id: schema.deals.companyId,
        amount_minor: schema.paymentRequests.amountMinor,
        currency: schema.paymentRequests.currency,
        description: schema.paymentRequests.description,
        status: schema.paymentRequests.status,
        provider: schema.paymentRequests.provider,
        provider_ref: schema.paymentRequests.providerRef,
        due_at: schema.paymentRequests.expiresAt,
        paid_at: schema.paymentRequests.paidAt,
        created_at: schema.paymentRequests.createdAt,
      })
      .from(schema.paymentRequests)
      .innerJoin(schema.deals, eq(schema.deals.id, schema.paymentRequests.opportunityId))
      .where(and(eq(schema.paymentRequests.workspaceId, ctx.workspaceId), parsed.data.status ? eq(schema.paymentRequests.status, parsed.data.status) : undefined))
      .orderBy(desc(schema.paymentRequests.createdAt))
      .limit(500);
    return {
      data: rows.map((r) => ({ ...r, amount_minor: Number(r.amount_minor), due_at: r.due_at?.toISOString() ?? null, paid_at: r.paid_at?.toISOString() ?? null, created_at: r.created_at.toISOString() })),
    };
  });

  // ---- E-signature (COPS-08) ----

  app.post<IdOnly>(
    "/contracts/:id/envelopes",
    { preHandler: sendGate },
    withCopsIdempotentReply<IdOnly>(idempotency, async (request, reply) => {
      const ctx = ctxOf(request);
      const bad = checkId(reply, ctx.requestId, request.params.id);
      if (bad) return bad;
      const parsed = envelopeSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
      return run(
        reply,
        ctx.requestId,
        async () => {
          await assertContractApproved(db, ctx.workspaceId, request.params.id);
          return sendEnvelope(db, ctx, esign, request.params.id, parsed.data, (url) => resolveContractDocumentForProvider(app.config, ctx.workspaceId, url));
        },
        (envelope) => reply.status(201).send({ data: envelope })
      );
    })
  );

  // The account's region, segment and legal entity, which pick the contract template (custom fields).
  const contractFieldsSchema = z
    .object({ region: z.string().trim().max(100), segment: z.string().trim().max(100), legal_entity: z.string().trim().max(200) })
    .partial()
    .strict();
  app.get<IdOnly>("/accounts/:id/contract-fields", { preHandler: contractReadGate }, async (request, reply) => {
    const ctx = ctxOf(request);
    const bad = checkId(reply as unknown as Reply, ctx.requestId, request.params.id);
    if (bad) return bad;
    return { data: await getAccountContractFields(db, ctx.workspaceId, request.params.id) };
  });
  app.put<IdOnly>("/accounts/:id/contract-fields", { preHandler: contractWriteGate }, async (request, reply) => {
    const ctx = ctxOf(request);
    const bad = checkId(reply as unknown as Reply, ctx.requestId, request.params.id);
    if (bad) return bad;
    const parsed = contractFieldsSchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply as unknown as Reply, ctx.requestId, parsed.error);
    return run(reply as unknown as Reply, ctx.requestId, () => setAccountContractFields(db, ctx, request.params.id, parsed.data), (data) => ({ data }));
  });

  app.get<IdOnly>("/contracts/:id/envelopes", { preHandler: contractReadGate }, async (request, reply) => {
    const ctx = ctxOf(request);
    const bad = checkId(reply as unknown as Reply, ctx.requestId, request.params.id);
    if (bad) return bad;
    return { data: await listEnvelopes(db, ctx.workspaceId, { contractId: request.params.id }) };
  });

  app.post<{ Params: { provider: string } }>("/esign/webhooks/:provider", async (request, reply) => {
    const requestId = resolveCorrelationId(request.headers["x-request-id"]);
    if (request.params.provider !== esign.provider) {
      return reply.status(404).send(copsErrorBody({ code: "NOT_FOUND", message: "Unknown e-sign provider", requestId }));
    }
    const rawBody = request.rawBody ?? JSON.stringify(request.body ?? {});
    const result = await handleEsignWebhook(db, esign, rawBody, request.headers, requestId, async (tx, signed) => {
      await evaluateGate(tx as unknown as Db, {
        workspaceId: signed.workspaceId,
        opportunityId: signed.opportunityId,
        trigger: "signature",
        actor: { type: "integration", id: esign.provider },
        requestId,
      });
    });
    if (result.kind === "unauthorized") {
      return reply.status(401).send(copsErrorBody({ code: "UNAUTHENTICATED", message: "Invalid webhook signature", requestId }));
    }
    if (result.kind === "bad_request") {
      return reply.status(400).send(copsErrorBody({ code: "VALIDATION_FAILED", message: "Unreadable webhook body", requestId }));
    }
    if (result.kind === "duplicate") return { ok: true, duplicate: true };
    return { ok: true, duplicate: false, outcome: result.outcome, status: result.status };
  });

  // ---- Proposals ----

  type OppBody = { Params: { id: string }; Body: unknown };
  app.post<OppBody>(
    "/opportunities/:id/proposals",
    { preHandler: proposalWriteGate },
    withCopsIdempotentReply<OppBody>(idempotency, async (request, reply) => {
      const ctx = ctxOf(request);
      const bad = checkId(reply, ctx.requestId, request.params.id);
      if (bad) return bad;
      const parsed = createProposalSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
      return run(
        reply,
        ctx.requestId,
        async () => {
          const id = await createProposal(db, ctx, request.params.id, parsed.data);
          return (await loadProposals(db, ctx.workspaceId, { proposalId: id }))[0];
        },
        (proposal) => reply.status(201).send({ data: proposal })
      );
    })
  );

  app.get<{ Params: { id: string } }>("/proposals/:id", { preHandler: readGate }, async (request, reply) => {
    const requestId = resolveCorrelationId(request.headers["x-request-id"]);
    const bad = checkId(reply as never, requestId, request.params.id);
    if (bad) return bad;
    const [proposal] = await loadProposals(db, request.workspaceId!, { proposalId: request.params.id });
    if (!proposal) return reply.status(404).send(copsErrorBody({ code: "NOT_FOUND", message: "Proposal not found", requestId }));
    return { data: proposal };
  });

  type IdBody = { Params: { id: string }; Body: unknown };
  app.post<IdBody>(
    "/proposals/:id/versions",
    { preHandler: proposalWriteGate },
    withCopsIdempotentReply<IdBody>(idempotency, async (request, reply) => {
      const ctx = ctxOf(request);
      const bad = checkId(reply, ctx.requestId, request.params.id);
      if (bad) return bad;
      const parsed = termsSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
      return run(
        reply,
        ctx.requestId,
        async () => {
          await addProposalVersion(db, ctx, request.params.id, parsed.data);
          return (await loadProposals(db, ctx.workspaceId, { proposalId: request.params.id }))[0];
        },
        (proposal) => reply.status(201).send({ data: proposal })
      );
    })
  );

  app.post<IdBody>(
    "/proposals/:id/send",
    { preHandler: sendGate },
    withCopsIdempotentReply<IdBody>(idempotency, async (request, reply) => {
      const ctx = ctxOf(request);
      const bad = checkId(reply, ctx.requestId, request.params.id);
      if (bad) return bad;
      const parsed = sendSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
      return run(
        reply,
        ctx.requestId,
        async () => {
          // COPS-08: a proposal over a threshold goes out only once every approver has agreed.
          await assertApproved(db, ctx.workspaceId, request.params.id);
          await sendProposal(db, ctx, request.params.id);
          return (await loadProposals(db, ctx.workspaceId, { proposalId: request.params.id }))[0];
        },
        (proposal) => ({ data: proposal })
      );
    })
  );

  // A draft that was never sent can be deleted, with a reason; sent proposals stay.
  app.post<IdBody>(
    "/proposals/:id/discard",
    { preHandler: statusGate },
    withCopsIdempotentReply<IdBody>(idempotency, async (request, reply) => {
      const ctx = ctxOf(request);
      const bad = checkId(reply, ctx.requestId, request.params.id);
      if (bad) return bad;
      const parsed = discardSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
      return run(
        reply,
        ctx.requestId,
        async () => {
          await discardDraftProposal(db, ctx, request.params.id, parsed.data.reason);
          return { id: request.params.id, discarded: true };
        },
        (result) => ({ data: result })
      );
    })
  );

  app.post<IdBody>(
    "/contracts/:id/discard",
    { preHandler: statusGate },
    withCopsIdempotentReply<IdBody>(idempotency, async (request, reply) => {
      const ctx = ctxOf(request);
      const bad = checkId(reply, ctx.requestId, request.params.id);
      if (bad) return bad;
      const parsed = discardSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
      return run(
        reply,
        ctx.requestId,
        async () => {
          await discardDraftContract(db, ctx, request.params.id, parsed.data.reason);
          return { id: request.params.id, discarded: true };
        },
        (result) => ({ data: result })
      );
    })
  );

  app.post<IdBody>(
    "/proposals/:id/status",
    { preHandler: statusGate },
    withCopsIdempotentReply<IdBody>(idempotency, async (request, reply) => {
      const ctx = ctxOf(request);
      const bad = checkId(reply, ctx.requestId, request.params.id);
      if (bad) return bad;
      const parsed = proposalStatusSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
      return run(
        reply,
        ctx.requestId,
        async () => {
          await setProposalStatus(db, ctx, request.params.id, parsed.data.status, parsed.data.reason);
          return (await loadProposals(db, ctx.workspaceId, { proposalId: request.params.id }))[0];
        },
        (proposal) => ({ data: proposal })
      );
    })
  );

  // ---- Contracts ----

  app.post<OppBody>(
    "/opportunities/:id/contracts",
    { preHandler: contractWriteGate },
    withCopsIdempotentReply<OppBody>(idempotency, async (request, reply) => {
      const ctx = ctxOf(request);
      const bad = checkId(reply, ctx.requestId, request.params.id);
      if (bad) return bad;
      const parsed = createContractSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
      return run(
        reply,
        ctx.requestId,
        async () => {
          const id = await createContract(db, ctx, request.params.id, parsed.data);
          return (await loadContracts(db, ctx.workspaceId, { contractId: id }))[0];
        },
        (contract) => reply.status(201).send({ data: contract })
      );
    })
  );

  app.get<{ Params: { id: string } }>("/contracts/:id", { preHandler: contractReadGate }, async (request, reply) => {
    const requestId = resolveCorrelationId(request.headers["x-request-id"]);
    const bad = checkId(reply as never, requestId, request.params.id);
    if (bad) return bad;
    const [contract] = await loadContracts(db, request.workspaceId!, { contractId: request.params.id });
    if (!contract) return reply.status(404).send(copsErrorBody({ code: "NOT_FOUND", message: "Contract not found", requestId }));
    return { data: contract };
  });

  app.post<IdBody>(
    "/contracts/:id/versions",
    { preHandler: statusGate },
    withCopsIdempotentReply<IdBody>(idempotency, async (request, reply) => {
      const ctx = ctxOf(request);
      const bad = checkId(reply, ctx.requestId, request.params.id);
      if (bad) return bad;
      const parsed = documentSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
      return run(
        reply,
        ctx.requestId,
        async () => {
          await addContractVersion(db, ctx, request.params.id, parsed.data);
          return (await loadContracts(db, ctx.workspaceId, { contractId: request.params.id }))[0];
        },
        (contract) => reply.status(201).send({ data: contract })
      );
    })
  );

  app.post<IdBody>(
    "/contracts/:id/negotiated-versions",
    { preHandler: statusGate },
    withCopsIdempotentReply<IdBody>(idempotency, async (request, reply) => {
      const ctx = ctxOf(request);
      const bad = checkId(reply, ctx.requestId, request.params.id);
      if (bad) return bad;
      const parsed = negotiatedVersionSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
      return run(
        reply,
        ctx.requestId,
        async () => {
          await attachNegotiatedVersion(db, ctx, request.params.id, parsed.data);
          return (await loadContracts(db, ctx.workspaceId, { contractId: request.params.id }))[0];
        },
        (contract) => reply.status(201).send({ data: contract })
      );
    })
  );

  app.post<IdBody>(
    "/contracts/:id/send",
    { preHandler: sendGate },
    withCopsIdempotentReply<IdBody>(idempotency, async (request, reply) => {
      const ctx = ctxOf(request);
      const bad = checkId(reply, ctx.requestId, request.params.id);
      if (bad) return bad;
      return run(
        reply,
        ctx.requestId,
        async () => {
          await assertContractApproved(db, ctx.workspaceId, request.params.id);
          await sendContract(db, ctx, request.params.id);
          return (await loadContracts(db, ctx.workspaceId, { contractId: request.params.id }))[0];
        },
        (contract) => ({ data: contract })
      );
    })
  );

  app.post<IdBody>(
    "/contracts/:id/status",
    { preHandler: statusGate },
    withCopsIdempotentReply<IdBody>(idempotency, async (request, reply) => {
      const ctx = ctxOf(request);
      const bad = checkId(reply, ctx.requestId, request.params.id);
      if (bad) return bad;
      const parsed = contractStatusSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
      return run(
        reply,
        ctx.requestId,
        async () => {
          await setContractStatus(db, ctx, request.params.id, {
            status: parsed.data.status,
            reason: parsed.data.reason,
            signedAt: parsed.data.signed_at ? new Date(parsed.data.signed_at) : undefined,
          }, async (tx, contract) => {
            await evaluateGate(tx, {
              workspaceId: ctx.workspaceId,
              opportunityId: contract.opportunityId,
              trigger: "signature",
              actor: { type: "user", id: ctx.userId },
              requestId: ctx.requestId,
            });
          });
          return (await loadContracts(db, ctx.workspaceId, { contractId: request.params.id }))[0];
        },
        (contract) => ({ data: contract })
      );
    })
  );

  // ---- Payment requests ----

  type PayBody = { Body: unknown };
  app.post<PayBody>(
    "/payment-requests",
    { preHandler: paymentWriteGate },
    withCopsIdempotentReply<PayBody>(idempotency, async (request, reply) => {
      const ctx = ctxOf(request);
      const parsed = paymentRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
      return run(
        reply,
        ctx.requestId,
        async () => {
          const id = await createPaymentRequest(db, psp, ctx, parsed.data);
          return (await loadPaymentRequests(db, ctx.workspaceId, { id }))[0];
        },
        (paymentRequest) => reply.status(201).send({ data: paymentRequest })
      );
    })
  );

  app.get<{ Params: { id: string } }>("/payment-requests/:id", { preHandler: paymentReadGate }, async (request, reply) => {
    const requestId = resolveCorrelationId(request.headers["x-request-id"]);
    const bad = checkId(reply as never, requestId, request.params.id);
    if (bad) return bad;
    const [paymentRequest] = await loadPaymentRequests(db, request.workspaceId!, { id: request.params.id });
    if (!paymentRequest) {
      return reply.status(404).send(copsErrorBody({ code: "NOT_FOUND", message: "Payment request not found", requestId }));
    }
    return { data: paymentRequest };
  });

  /**
   * Provider webhook. Public under /billing/webhooks/ (plugins/auth.ts) and authenticated by the
   * HMAC signature instead: missing secret, missing or bad signature -> 401.
   */
  app.post("/billing/webhooks/razorpay/payment-links", async (request, reply) => {
    const requestId = resolveCorrelationId(request.headers["x-request-id"]);
    const rawBody = request.rawBody ?? JSON.stringify(request.body ?? {});
    const result = await handlePaymentWebhook(db, psp, rawBody, request.headers, async (tx, paid) => {
      await evaluateGate(tx, {
        workspaceId: paid.workspaceId,
        opportunityId: paid.opportunityId,
        trigger: "payment",
        actor: { type: "integration", id: psp.provider },
        requestId: paid.requestId,
      });
      // COPS-04: credits bought on this deal go to the account's wallet once payment is confirmed.
      const [deal] = await tx
        .select({ companyId: schema.deals.companyId })
        .from(schema.deals)
        .where(and(eq(schema.deals.id, paid.opportunityId), eq(schema.deals.workspaceId, paid.workspaceId)))
        .limit(1);
      if (deal?.companyId) {
        await applyPaidCreditPurchases(tx, { operatorWorkspaceId: paid.workspaceId, accountId: deal.companyId, requestId: paid.requestId });
      }
    }, async (tx, refunded) => {
      // COPS-04 Q4: a refund takes back the credits that payment bought.
      const [deal] = await tx
        .select({ companyId: schema.deals.companyId })
        .from(schema.deals)
        .where(and(eq(schema.deals.id, refunded.opportunityId), eq(schema.deals.workspaceId, refunded.workspaceId)))
        .limit(1);
      if (deal?.companyId && refunded.paymentRequestId) {
        await reverseRefundedCreditPurchase(tx, {
          operatorWorkspaceId: refunded.workspaceId,
          accountId: deal.companyId,
          paymentRequestId: refunded.paymentRequestId,
          requestId: refunded.requestId,
        });
      }
    });
    if (result.kind === "unauthorized") {
      return reply.status(401).send(copsErrorBody({ code: "UNAUTHENTICATED", message: "Invalid webhook signature", requestId }));
    }
    if (result.kind === "bad_request") {
      return reply.status(400).send(copsErrorBody({ code: "VALIDATION_FAILED", message: "Unreadable webhook body", requestId }));
    }
    if (result.kind === "duplicate") return { ok: true, duplicate: true };
    return { ok: true, duplicate: false, outcome: result.outcome, status: result.status ?? null };
  });

  // ---- Provisioning gate ----

  const approveGate = requireAnyCopsPermission(["commercial:approve"], perms);
  const policyAdminGate = requireAnyCopsPermission(["commercial:admin"], perms);
  const dealTypeGate = requireAnyCopsPermission(["commercial:write", "commercial:send"], perms);

  app.get<{ Params: { id: string } }>("/opportunities/:id/gate", { preHandler: readGate }, async (request, reply) => {
    const requestId = resolveCorrelationId(request.headers["x-request-id"]);
    const bad = checkId(reply as never, requestId, request.params.id);
    if (bad) return bad;
    return run(reply as never, requestId, () => getGate(db, request.workspaceId!, request.params.id), (gate) => ({ data: gate }));
  });

  const gateActions = [
    ["/opportunities/:id/gate/approve-trial", approveTrial],
    ["/opportunities/:id/gate/override", overrideGate],
  ] as const;
  for (const [path, action] of gateActions) {
    app.post<IdBody>(
      path,
      { preHandler: approveGate },
      withCopsIdempotentReply<IdBody>(idempotency, async (request, reply) => {
        const ctx = ctxOf(request);
        const bad = checkId(reply, ctx.requestId, request.params.id);
        if (bad) return bad;
        const parsed = gateReasonSchema.safeParse(request.body ?? {});
        if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
        return run(
          reply,
          ctx.requestId,
          async () => {
            const result = await action(db, ctx, request.params.id, parsed.data.reason);
            return { ...(await getGate(db, ctx.workspaceId, request.params.id)), fired_now: result.fired };
          },
          (gate) => ({ data: gate })
        );
      })
    );
  }

  app.put<IdBody>(
    "/opportunities/:id/deal-type",
    { preHandler: dealTypeGate },
    withCopsIdempotentReply<IdBody>(idempotency, async (request, reply) => {
      const ctx = ctxOf(request);
      const bad = checkId(reply, ctx.requestId, request.params.id);
      if (bad) return bad;
      const parsed = dealTypeSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
      return run(
        reply,
        ctx.requestId,
        async () => {
          await setDealType(db, ctx, request.params.id, parsed.data.deal_type);
          return getGate(db, ctx.workspaceId, request.params.id);
        },
        (gate) => ({ data: gate })
      );
    })
  );

  app.get("/commercial/gate-policies", { preHandler: readGate }, async (request) => ({
    data: await listGatePolicies(db, request.workspaceId!),
  }));

  app.put<PayBody>(
    "/commercial/gate-policies",
    { preHandler: policyAdminGate },
    withCopsIdempotentReply<PayBody>(idempotency, async (request, reply) => {
      const ctx = ctxOf(request);
      const parsed = gatePolicySchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
      return run(
        reply,
        ctx.requestId,
        async () => {
          await setGatePolicy(db, ctx, parsed.data.deal_type, parsed.data.policy);
          return listGatePolicies(db, ctx.workspaceId);
        },
        (policies) => ({ data: policies })
      );
    })
  );

  // ---- Summaries for the Commercial Desk and the Customer 360 Commercial tab. Clients poll these. ----

  async function summaries(workspaceId: string, opportunityIds: string[]) {
    if (opportunityIds.length === 0) return [];
    const { deals, copsLifecycleStates } = schema;
    const [opps, states, proposalRows, contractRows, paymentRows] = await Promise.all([
      db
        .select({ id: deals.id, name: deals.name, amount: deals.amount, currency: deals.currency, dealType: deals.dealType, status: deals.status })
        .from(deals)
        .where(and(eq(deals.workspaceId, workspaceId), inArray(deals.id, opportunityIds))),
      db
        .select({ entityId: copsLifecycleStates.entityId, state: copsLifecycleStates.state })
        .from(copsLifecycleStates)
        .where(
          and(
            eq(copsLifecycleStates.workspaceId, workspaceId),
            eq(copsLifecycleStates.dimension, "commercial"),
            inArray(copsLifecycleStates.entityId, opportunityIds)
          )
        ),
      loadProposals(db, workspaceId, { opportunityIds }),
      loadContracts(db, workspaceId, { opportunityIds }),
      loadPaymentRequests(db, workspaceId, { opportunityIds }),
    ]);
    const gates = await Promise.all(opps.map((o) => getGate(db, workspaceId, o.id)));
    return opps.map((o, i) => ({
      opportunity: {
        id: o.id,
        name: o.name,
        amount: o.amount,
        currency: o.currency,
        deal_type: o.dealType,
        status: o.status,
        commercial_state: states.find((st) => st.entityId === o.id)?.state ?? null,
      },
      proposals: proposalRows.filter((p) => p.opportunity_id === o.id),
      contracts: contractRows.filter((c) => c.opportunity_id === o.id),
      payment_requests: paymentRows.filter((p) => p.opportunity_id === o.id),
      gate: gates[i],
    }));
  }

  app.get<{ Params: { id: string } }>("/opportunities/:id/commercial", { preHandler: readGate }, async (request, reply) => {
    const requestId = resolveCorrelationId(request.headers["x-request-id"]);
    const bad = checkId(reply as never, requestId, request.params.id);
    if (bad) return bad;
    return run(
      reply as never,
      requestId,
      async () => {
        await getOpportunity(db, request.workspaceId!, request.params.id);
        return (await summaries(request.workspaceId!, [request.params.id]))[0];
      },
      (summary) => ({ data: summary })
    );
  });

  app.get<{ Params: { id: string } }>("/accounts/:id/commercial", { preHandler: readGate }, async (request, reply) => {
    const requestId = resolveCorrelationId(request.headers["x-request-id"]);
    const bad = checkId(reply as never, requestId, request.params.id);
    if (bad) return bad;
    const { deals } = schema;
    // Open and won opportunities of the account; lost ones have no commercial work left.
    const opps = await db
      .select({ id: deals.id })
      .from(deals)
      .where(
        and(
          eq(deals.workspaceId, request.workspaceId!),
          eq(deals.companyId, request.params.id),
          isNull(deals.deletedAt),
          inArray(deals.status, ["open", "won"])
        )
      )
      .limit(20);
    return { data: await summaries(request.workspaceId!, opps.map((o) => o.id)) };
  });

  // Commercial Desk across accounts: every open and won opportunity, most recently changed first.
  app.get<{ Querystring: { state?: string; cursor?: string; limit?: string } }>(
    "/commercial/opportunities",
    { preHandler: readGate },
    async (request, reply) => {
      const requestId = resolveCorrelationId(request.headers["x-request-id"]);
      const parsed = deskQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) return invalid(reply as never, requestId, parsed.error);
      const { state, limit } = parsed.data;
      const after = parsed.data.cursor ? decodeDeskCursor(parsed.data.cursor) : null;
      if (parsed.data.cursor && !after) {
        return reply.status(422).send(
          copsErrorBody({
            code: "VALIDATION_FAILED",
            message: "Invalid cursor",
            requestId,
            details: { fields: [{ path: "cursor", code: "invalid_cursor", message: "Invalid cursor" }] },
          })
        );
      }
      const { deals, companies, copsLifecycleStates } = schema;
      const updatedText = sql<string>`${deals.updatedAt}::text`;
      const conditions = [eq(deals.workspaceId, request.workspaceId!), isNull(deals.deletedAt), inArray(deals.status, ["open", "won"])];
      if (state === "none") conditions.push(isNull(copsLifecycleStates.state));
      else if (state) conditions.push(eq(copsLifecycleStates.state, state));
      if (after) conditions.push(sql`(${deals.updatedAt}, ${deals.id}) < (${after.updatedAt}::timestamptz, ${after.id}::uuid)`);
      const rows = await db
        .select({ id: deals.id, updatedAt: updatedText, companyId: deals.companyId, companyName: companies.name })
        .from(deals)
        .leftJoin(companies, and(eq(companies.id, deals.companyId), eq(companies.workspaceId, deals.workspaceId)))
        .leftJoin(
          copsLifecycleStates,
          and(
            eq(copsLifecycleStates.workspaceId, deals.workspaceId),
            eq(copsLifecycleStates.dimension, "commercial"),
            eq(copsLifecycleStates.entityId, deals.id)
          )
        )
        .where(and(...conditions))
        .orderBy(desc(deals.updatedAt), desc(deals.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const byId = new Map((await summaries(request.workspaceId!, page.map((r) => r.id))).map((s) => [s.opportunity.id, s]));
      const last = page[page.length - 1];
      return {
        data: page.flatMap((r) => {
          const summary = byId.get(r.id);
          return summary ? [{ ...summary, account: r.companyId ? { id: r.companyId, name: r.companyName } : null }] : [];
        }),
        next_cursor: rows.length > limit && last ? encodeDeskCursor(last.updatedAt, last.id) : null,
      };
    }
  );
}

const DESK_STATES = ["none", "proposal_sent", "msa_pending", "payment_pending", "complete"] as const;
const deskQuerySchema = z.object({
  state: z.enum(DESK_STATES).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});
const deskCursorSchema = z.object({ updated_at: z.string().min(10).max(40), id: z.string().uuid() });

/** `updatedAt` is the exact Postgres timestamp text (microseconds), so a page boundary never drops rows. */
export function encodeDeskCursor(updatedAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ updated_at: updatedAt, id }), "utf8").toString("base64url");
}

export function decodeDeskCursor(cursor: string): { updatedAt: string; id: string } | null {
  try {
    const parsed = deskCursorSchema.safeParse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    return parsed.success ? { updatedAt: parsed.data.updated_at, id: parsed.data.id } : null;
  } catch {
    return null;
  }
}
