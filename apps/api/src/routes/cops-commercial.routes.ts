import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { schema, type Db } from "@skout/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { BILLING_CADENCES, COMMERCIAL_GATE_POLICIES, COMMERCIAL_LINE_KINDS, copsErrorBody, copsErrorStatus, resolveCorrelationId } from "@skout/shared";
import { getMemberPermissions } from "@skout/auth";
import { copsIdempotencyStore, requireAnyCopsPermission } from "../services/cops-platform.service.js";
import { withCopsIdempotentReply, type CopsCapturingReply } from "../services/cops-idempotent.js";
import {
  addContractVersion,
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
  type CommercialContext,
} from "../services/cops-commercial.service.js";
import { createPaymentRequest, handlePaymentWebhook, loadPaymentRequests } from "../services/cops-payments.service.js";
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const pct = z.number().min(0).max(100).multipleOf(0.01);
const lineItemSchema = z
  .object({
    kind: z.enum(COMMERCIAL_LINE_KINDS),
    description: z.string().trim().min(1).max(500),
    quantity: z.number().int().min(1).max(10_000_000),
    unit_amount_minor: z.number().int().min(0).max(1_000_000_000_000),
    discount_pct: pct.default(0),
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
    line_items: z.array(lineItemSchema).min(1).max(200),
  })
  .strict();
const createProposalSchema = termsSchema.extend({ title: z.string().trim().min(1).max(200) }).strict();
const sendSchema = z
  .object({ recipient_contact_ids: z.array(z.string().regex(UUID)).max(50).optional(), message: z.string().max(5000).optional() })
  .strict();
const reasonText = z.string().trim().min(1, "reason is required").max(1000);
const proposalStatusSchema = z.object({ status: z.enum(["accepted", "declined", "expired"]), reason: reasonText }).strict();
const documentSchema = z
  .object({
    document_url: z.string().trim().min(1).max(2000),
    file_name: z.string().trim().max(300).optional(),
    file_sha256: z.string().regex(/^[a-f0-9]{64}$/, "file_sha256 must be a lowercase hex SHA-256"),
  })
  .strict();
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

type Reply = CopsCapturingReply;

/**
 * COPS-03 proposals and contracts (status-tracking scope). Contract: docs/api/copos-03-commercial.openapi.yaml.
 * Every write needs an Idempotency-Key; reads need commercial:read. Sent versions are immutable.
 */
export async function copsCommercialRoutes(app: FastifyInstance, opts: { db: Db; psp?: PspAdapter }) {
  const { db } = opts;
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
          await sendProposal(db, ctx, request.params.id);
          return (await loadProposals(db, ctx.workspaceId, { proposalId: request.params.id }))[0];
        },
        (proposal) => ({ data: proposal })
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
}
