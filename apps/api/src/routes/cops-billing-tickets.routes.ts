import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Db } from "@skout/db";
import { getMemberPermissions } from "@skout/auth";
import { copsErrorBody, copsErrorStatus, resolveCorrelationId } from "@skout/shared";
import { requireAnyCopsPermission } from "../services/cops-platform.service.js";
import {
  BILLING_TICKET_ACT_KEYS,
  BILLING_TICKET_KINDS,
  BILLING_TICKET_STATUSES,
  BillingTicketError,
  assignBillingTicket,
  createBillingTicket,
  listBillingTickets,
  resolveBillingTicket,
} from "../services/cops-billing-tickets.service.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const createSchema = z
  .object({
    kind: z.enum(BILLING_TICKET_KINDS),
    payment_request_id: z.string().uuid().optional(),
    subscription_id: z.string().uuid().optional(),
    reason: z.string().trim().min(5, "Say what the customer asked and why").max(2000),
    assignee_id: z.string().uuid().nullable().optional(),
  })
  .strict();
const assignSchema = z.object({ assignee_id: z.string().uuid().nullable() }).strict();
const resolveSchema = z.object({ outcome: z.enum(["done", "declined"]), note: z.string().trim().max(2000).nullable().optional() }).strict();
const listSchema = z.object({
  status: z.enum([...BILLING_TICKET_STATUSES, "active"] as [string, ...string[]]).optional(),
  account_id: z.string().uuid().optional(),
  mine: z.enum(["true", "false"]).optional(),
});

/**
 * Billing tickets: a customer asks for a refund or a cancellation, Customer Success (or Sales)
 * raises it, and Finance takes it, does it and closes it, or declines it with a note.
 */
export async function copsBillingTicketsRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;
  const perms = (ws: string, user: string) => getMemberPermissions(db, ws, user);
  // Raise: whoever talks to the customer.
  const raiseGate = requireAnyCopsPermission(["tickets:write", "crm:write", ...BILLING_TICKET_ACT_KEYS], perms);
  // See the queue: Finance and the people who raise them.
  const readGate = requireAnyCopsPermission(["billing:read", "tickets:read", "crm:read", ...BILLING_TICKET_ACT_KEYS], perms);
  // Assign and close: Finance only.
  const actGate = requireAnyCopsPermission([...BILLING_TICKET_ACT_KEYS], perms);

  const ctxOf = (request: { workspaceId?: string; userId?: string; headers: Record<string, unknown> }) => ({
    workspaceId: request.workspaceId!,
    userId: request.userId!,
    requestId: resolveCorrelationId(request.headers["x-request-id"] as string | undefined),
  });
  const invalid = (reply: FastifyReply, requestId: string, error: z.ZodError) =>
    reply.status(copsErrorStatus("VALIDATION_FAILED")).send(
      copsErrorBody({
        code: "VALIDATION_FAILED",
        message: error.issues[0]?.message ?? "Invalid request",
        requestId,
        details: { fields: error.issues.map((i) => ({ path: i.path.join("."), code: i.code, message: i.message })) },
      })
    );
  const run = async <T>(reply: FastifyReply, requestId: string, fn: () => Promise<T>, status = 200) => {
    try {
      return reply.status(status).send({ data: await fn() });
    } catch (e) {
      if (e instanceof BillingTicketError) {
        return reply.status(e.code === "NOT_FOUND" ? 404 : copsErrorStatus(e.code)).send(copsErrorBody({ code: e.code, message: e.message, requestId, details: e.details }));
      }
      throw e;
    }
  };
  const badId = (reply: FastifyReply, requestId: string, id: string) =>
    UUID.test(id) ? null : reply.status(404).send(copsErrorBody({ code: "NOT_FOUND", message: "Not found", requestId }));

  app.post<{ Params: { id: string } }>("/accounts/:id/billing-tickets", { preHandler: raiseGate }, async (request, reply) => {
    const ctx = ctxOf(request);
    const bad = badId(reply, ctx.requestId, request.params.id);
    if (bad) return bad;
    const parsed = createSchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
    const b = parsed.data;
    return run(
      reply,
      ctx.requestId,
      () => createBillingTicket(db, ctx, { accountId: request.params.id, kind: b.kind, paymentRequestId: b.payment_request_id, subscriptionId: b.subscription_id, reason: b.reason, assigneeId: b.assignee_id ?? null }),
      201
    );
  });

  app.get<{ Querystring: Record<string, string> }>("/billing-tickets", { preHandler: readGate }, async (request, reply) => {
    const ctx = ctxOf(request);
    const parsed = listSchema.safeParse(request.query ?? {});
    if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
    const q = parsed.data;
    return run(reply, ctx.requestId, () =>
      listBillingTickets(db, ctx.workspaceId, {
        status: q.status as never,
        accountId: q.account_id,
        assigneeId: q.mine === "true" ? ctx.userId : undefined,
      })
    );
  });

  app.post<{ Params: { id: string } }>("/billing-tickets/:id/assign", { preHandler: actGate }, async (request, reply) => {
    const ctx = ctxOf(request);
    const bad = badId(reply, ctx.requestId, request.params.id);
    if (bad) return bad;
    const parsed = assignSchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
    return run(reply, ctx.requestId, () => assignBillingTicket(db, ctx, request.params.id, parsed.data.assignee_id));
  });

  app.post<{ Params: { id: string } }>("/billing-tickets/:id/resolve", { preHandler: actGate }, async (request, reply) => {
    const ctx = ctxOf(request);
    const bad = badId(reply, ctx.requestId, request.params.id);
    if (bad) return bad;
    const parsed = resolveSchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
    return run(reply, ctx.requestId, () => resolveBillingTicket(db, ctx, request.params.id, parsed.data));
  });
}
