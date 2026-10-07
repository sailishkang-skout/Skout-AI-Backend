import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "@skout/db";
import { BILLING_CADENCES, COMMERCIAL_LINE_KINDS, copsErrorBody, copsErrorStatus, resolveCorrelationId } from "@skout/shared";
import { getMemberPermissions } from "@skout/auth";
import { copsIdempotencyStore, requireAnyCopsPermission } from "../services/cops-platform.service.js";
import { withCopsIdempotentReply, type CopsCapturingReply } from "../services/cops-idempotent.js";
import {
  addContractVersion,
  addProposalVersion,
  CommercialError,
  createContract,
  createProposal,
  loadContracts,
  loadProposals,
  sendContract,
  sendProposal,
  setContractStatus,
  setProposalStatus,
  type CommercialContext,
} from "../services/cops-commercial.service.js";

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
const contractStatusSchema = z
  .object({ status: z.enum(["signed", "declined", "expired"]), reason: reasonText, signed_at: z.string().datetime().optional() })
  .strict();

type Reply = CopsCapturingReply;

/**
 * COPS-03 proposals and contracts (status-tracking scope). Contract: docs/api/copos-03-commercial.openapi.yaml.
 * Every write needs an Idempotency-Key; reads need commercial:read. Sent versions are immutable.
 */
export async function copsCommercialRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;
  const perms = (ws: string, user: string) => getMemberPermissions(db, ws, user);
  const readGate = requireAnyCopsPermission(["commercial:read"], perms);
  const contractReadGate = requireAnyCopsPermission(["commercial:read", "legal:read"], perms);
  const proposalWriteGate = requireAnyCopsPermission(["commercial:send", "commercial:write"], perms);
  const contractWriteGate = requireAnyCopsPermission(["commercial:write", "legal:write", "commercial:send"], perms);
  const sendGate = requireAnyCopsPermission(["commercial:send"], perms);
  const statusGate = requireAnyCopsPermission(["commercial:write", "legal:write"], perms);
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
          });
          return (await loadContracts(db, ctx.workspaceId, { contractId: request.params.id }))[0];
        },
        (contract) => ({ data: contract })
      );
    })
  );
}
