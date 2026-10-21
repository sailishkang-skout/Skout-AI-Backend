import type { FastifyInstance } from "fastify";
import { ticketMetrics } from "../services/cops-ticket-metrics.service.js";
import { getTicketSla, slaSummaries } from "../services/cops-sla.service.js";
import { z } from "zod";
import { schema, type Db } from "@skout/db";
import { and, eq } from "drizzle-orm";
import {
  copsErrorBody,
  copsErrorStatus,
  resolveCorrelationId,
  TICKET_CATEGORIES,
  TICKET_ENVIRONMENTS,
  TICKET_PRIORITIES,
  TICKET_SEVERITIES,
  TICKET_STATUSES,
  TICKET_VISIBILITIES,
} from "@skout/shared";
import { getMemberPermissions } from "@skout/auth";
import { copsIdempotencyStore, requireAnyCopsPermission } from "../services/cops-platform.service.js";
import { withCopsIdempotentReply, type CopsCapturingReply } from "../services/cops-idempotent.js";
import {
  addTicketComment,
  createTicket,
  customerSafeTicket,
  escalateTicket,
  getTicket,
  listTickets,
  loadAccountTickets,
  setCommentVisibility,
  TicketError,
  recordTicketRelease,
  ticketPrefill,
  transitionTicket,
  updateTicket,
} from "../services/cops-tickets.service.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const id = z.string().regex(UUID, "Invalid id");

const createSchema = z
  .object({
    account_id: id,
    contact_id: id.optional(),
    opportunity_id: id.optional(),
    milestone_id: id.optional(),
    title: z.string().trim().min(1, "title is required").max(200),
    description: z.string().max(10000).optional(),
    category: z.enum(TICKET_CATEGORIES).optional(),
    severity: z.enum(TICKET_SEVERITIES).optional(),
    priority: z.enum(TICKET_PRIORITIES).optional(),
    impact: z.string().trim().max(1000).optional(),
    affected_feature: z.string().trim().max(200).optional(),
    environment: z.enum(TICKET_ENVIRONMENTS).optional(),
    repro_steps: z.string().max(10000).optional(),
    log_refs: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
    diagnostics: z.record(z.unknown()).optional(),
    team: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

const queueSchema = z.object({
  severity: z.enum(TICKET_SEVERITIES).optional(),
  status: z.enum(TICKET_STATUSES).optional(),
  open: z.enum(["true", "false"]).optional(),
  assignee: z.union([z.enum(["me", "unassigned"]), id]).optional(),
  tier: z.enum(["smb", "mid_market", "enterprise"]).optional(),
  team: z.string().trim().min(1).max(80).optional(),
  account_id: id.optional(),
  cursor: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});
const prefillSchema = z.object({ account_id: id, milestone_id: id.optional(), blocker: z.string().trim().min(1).max(64).optional() });
const transitionSchema = z.object({ to: z.enum(TICKET_STATUSES), reason: z.string().trim().max(1000).optional() }).strict();
const escalateSchema = z.object({ severity: z.enum(TICKET_SEVERITIES), reason: z.string().trim().min(1, "reason is required").max(1000) }).strict();
const updateSchema = z
  .object({ assignee_id: id.nullable().optional(), team: z.string().trim().min(1).max(80).nullable().optional(), priority: z.enum(TICKET_PRIORITIES).optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");
const commentSchema = z
  .object({
    body: z.string().trim().min(1, "body is required").max(10000),
    visibility: z.enum(TICKET_VISIBILITIES),
    kind: z.enum(["note", "update", "ai_summary"]).optional(),
    source_comment_ids: z.array(id).max(50).optional(),
  })
  .strict();
const visibilitySchema = z.object({ visibility: z.enum(TICKET_VISIBILITIES), reason: z.string().trim().min(1, "reason is required").max(1000) }).strict();

type Reply = CopsCapturingReply;

/**
 * COPS-06 engineering tickets. Contract: docs/api/copos-06-tickets.openapi.yaml.
 * tickets:read sees the queue and a ticket; tickets:write works it. A rep raises a ticket from an
 * account with crm:write (Sales hold no ticket keys). Publishing anything customer-visible needs
 * tickets:send, checked in the service next to the write.
 */
export async function copsTicketsRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;
  const perms = (ws: string, user: string) => getMemberPermissions(db, ws, user);
  const readGate = requireAnyCopsPermission(["tickets:read"], perms);
  const accountReadGate = requireAnyCopsPermission(["tickets:read", "crm:read"], perms);
  const writeGate = requireAnyCopsPermission(["tickets:write"], perms);
  const createGate = requireAnyCopsPermission(["tickets:write", "crm:write"], perms);
  const idempotency = copsIdempotencyStore(db);

  const ctxOf = (request: { workspaceId?: string; userId?: string; headers: Record<string, unknown> }) => ({
    workspaceId: request.workspaceId!,
    userId: request.userId!,
    requestId: resolveCorrelationId(request.headers["x-request-id"] as string | undefined),
  });
  const canPublish = async (ctx: { workspaceId: string; userId: string }) => (await perms(ctx.workspaceId, ctx.userId)).includes("tickets:send");

  function invalid(reply: Reply, requestId: string, error: z.ZodError | { path: string; message: string }) {
    const fields =
      error instanceof z.ZodError
        ? error.issues.map((i) => ({ path: i.path.join(".") || "body", code: i.code, message: i.message }))
        : [{ path: error.path, code: "invalid", message: error.message }];
    return reply
      .status(copsErrorStatus("VALIDATION_FAILED"))
      .send(copsErrorBody({ code: "VALIDATION_FAILED", message: fields[0]?.message ?? "Invalid request", requestId, details: { fields } }));
  }

  async function run<T>(reply: Reply, requestId: string, fn: () => Promise<T>, onOk: (value: T) => unknown) {
    try {
      return onOk(await fn());
    } catch (error) {
      if (error instanceof TicketError) {
        return reply.status(error.status).send(copsErrorBody({ code: error.code, message: error.message, requestId, details: error.details }));
      }
      const e = error as { code?: string; status?: number; message?: string };
      // CopsIllegalTransitionError from the lifecycle `support` dimension.
      if (e.code === "BUSINESS_STATE_CONFLICT" && e.status === 409) {
        return reply.status(409).send(copsErrorBody({ code: "BUSINESS_STATE_CONFLICT", message: e.message ?? "Conflict", requestId }));
      }
      throw error;
    }
  }

  type IdParams = { Params: { id: string }; Body: unknown };

  app.get<{ Querystring: unknown }>("/tickets", { preHandler: readGate }, async (request, rawReply) => {
    const reply = rawReply as unknown as Reply;
    const ctx = ctxOf(request);
    const parsed = queueSchema.safeParse(request.query ?? {});
    if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
    const { open, ...filters } = parsed.data;
    return run(
      reply,
      ctx.requestId,
      async () => {
        const page = await listTickets(db, ctx, { ...filters, open: open === "true" });
        // COPS-12: each queue row carries its worst SLA clock (state and due time).
        const sla = await slaSummaries(db, ctx.workspaceId, (page.data as { id: string }[]).map((t) => t.id));
        return { ...page, data: (page.data as { id: string }[]).map((t) => ({ ...t, sla: sla.get(t.id) ?? null })) };
      },
      (page) => page
    );
  });

  /** COPS-12 engineering dashboard metrics (Bible p.56). */
  app.get<{ Querystring: unknown }>("/tickets/metrics", { preHandler: readGate }, async (request, rawReply) => {
    const reply = rawReply as unknown as Reply;
    const ctx = ctxOf(request);
    const parsed = z
      .object({ days: z.coerce.number().int().min(1).max(365).default(30), tier: z.enum(["smb", "mid_market", "enterprise"]).optional(), team: z.string().max(100).optional() })
      .safeParse(request.query ?? {});
    if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
    return run(reply, ctx.requestId, () => ticketMetrics(db, ctx.workspaceId, parsed.data), (data) => ({ data }));
  });

  /** Prefilled fields for "Create ticket" from an account or an onboarding blocker. */
  app.get<{ Querystring: unknown }>("/tickets/prefill", { preHandler: createGate }, async (request, rawReply) => {
    const reply = rawReply as unknown as Reply;
    const ctx = ctxOf(request);
    const parsed = prefillSchema.safeParse(request.query ?? {});
    if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
    return run(reply, ctx.requestId, () => ticketPrefill(db, ctx, parsed.data), (data) => ({ data }));
  });

  app.post<{ Body: unknown }>(
    "/tickets",
    { preHandler: createGate },
    withCopsIdempotentReply<{ Body: unknown }>(idempotency, async (request, reply) => {
      const ctx = ctxOf(request);
      const parsed = createSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
      return run(reply, ctx.requestId, () => createTicket(db, ctx, parsed.data), (r) => reply.status(201).send({ data: r.ticket, summary: r.summary }));
    })
  );

  app.get<IdParams>("/tickets/:id", { preHandler: readGate }, async (request, rawReply) => {
    const reply = rawReply as unknown as Reply;
    const ctx = ctxOf(request);
    if (!UUID.test(request.params.id)) return invalid(reply, ctx.requestId, { path: "id", message: "Invalid id" });
    return run(
      reply,
      ctx.requestId,
      async () => {
        const t = (await getTicket(db, ctx, request.params.id)) as { id: string; priority: string; account_tier: string; status: string };
        const sla = await getTicketSla(db, ctx.workspaceId, { id: t.id, priority: t.priority, accountTier: t.account_tier, status: t.status });
        // COPS-12: the incident this ticket is linked to, if any.
        const [incident] = await db
          .select({ id: schema.incidents.id, title: schema.incidents.title, status: schema.incidents.status, owner_id: schema.incidents.ownerId })
          .from(schema.incidentTicketLinks)
          .innerJoin(schema.incidents, eq(schema.incidents.id, schema.incidentTicketLinks.incidentId))
          .where(and(eq(schema.incidentTicketLinks.workspaceId, ctx.workspaceId), eq(schema.incidentTicketLinks.ticketId, t.id)))
          .limit(1);
        return { ...t, sla, incident: incident ?? null };
      },
      (data) => ({ data })
    );
  });

  /** COPS-12: the ticket's SLA clocks. */
  app.get<IdParams>("/tickets/:id/sla", { preHandler: readGate }, async (request, rawReply) => {
    const reply = rawReply as unknown as Reply;
    const ctx = ctxOf(request);
    if (!UUID.test(request.params.id)) return invalid(reply, ctx.requestId, { path: "id", message: "Invalid id" });
    return run(
      reply,
      ctx.requestId,
      async () => {
        const t = (await getTicket(db, ctx, request.params.id)) as { id: string; priority: string; account_tier: string; status: string };
        return getTicketSla(db, ctx.workspaceId, { id: t.id, priority: t.priority, accountTier: t.account_tier, status: t.status });
      },
      (data) => ({ data })
    );
  });

  /** COPS-12 (Bible p.55): release id, fixed-in version, deployed-at and verification evidence. */
  const releaseSchema = z
    .object({
      release_id: z.string().max(200).nullable().optional(),
      fixed_in_version: z.string().max(100).nullable().optional(),
      deployed_at: z.string().datetime().nullable().optional(),
      qa_evidence: z.string().max(4000).optional(),
      customer_evidence: z.string().max(4000).optional(),
    })
    .strict();
  app.patch<IdParams>("/tickets/:id/release", { preHandler: writeGate }, async (request, rawReply) => {
    const reply = rawReply as unknown as Reply;
    const ctx = ctxOf(request);
    if (!UUID.test(request.params.id)) return invalid(reply, ctx.requestId, { path: "id", message: "Invalid id" });
    const parsed = releaseSchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
    return run(reply, ctx.requestId, () => recordTicketRelease(db, ctx, request.params.id, parsed.data), (data) => ({ data }));
  });

  /** Customer-safe view: customer updates only, no internal notes or internal fields. */
  app.get<IdParams>("/tickets/:id/customer-view", { preHandler: accountReadGate }, async (request, rawReply) => {
    const reply = rawReply as unknown as Reply;
    const ctx = ctxOf(request);
    if (!UUID.test(request.params.id)) return invalid(reply, ctx.requestId, { path: "id", message: "Invalid id" });
    return run(reply, ctx.requestId, () => customerSafeTicket(db, ctx, request.params.id), (data) => ({ data }));
  });

  app.patch<IdParams>("/tickets/:id", { preHandler: writeGate }, async (request, rawReply) => {
    const reply = rawReply as unknown as Reply;
    const ctx = ctxOf(request);
    if (!UUID.test(request.params.id)) return invalid(reply, ctx.requestId, { path: "id", message: "Invalid id" });
    const parsed = updateSchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
    return run(reply, ctx.requestId, () => updateTicket(db, ctx, request.params.id, parsed.data), (r) => ({ data: r.ticket }));
  });

  app.post<IdParams>("/tickets/:id/transition", { preHandler: writeGate }, async (request, rawReply) => {
    const reply = rawReply as unknown as Reply;
    const ctx = ctxOf(request);
    if (!UUID.test(request.params.id)) return invalid(reply, ctx.requestId, { path: "id", message: "Invalid id" });
    const parsed = transitionSchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
    return run(reply, ctx.requestId, () => transitionTicket(db, ctx, request.params.id, parsed.data.to, parsed.data.reason), (r) => ({ data: r.ticket, summary: r.summary }));
  });

  app.post<IdParams>("/tickets/:id/escalate", { preHandler: writeGate }, async (request, rawReply) => {
    const reply = rawReply as unknown as Reply;
    const ctx = ctxOf(request);
    if (!UUID.test(request.params.id)) return invalid(reply, ctx.requestId, { path: "id", message: "Invalid id" });
    const parsed = escalateSchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
    return run(reply, ctx.requestId, () => escalateTicket(db, ctx, request.params.id, parsed.data), (r) => ({ data: r.ticket, summary: r.summary }));
  });

  /** Internal note or customer update; the visibility is explicit in the body, never defaulted. */
  app.post<IdParams>(
    "/tickets/:id/comments",
    { preHandler: writeGate },
    withCopsIdempotentReply<IdParams>(idempotency, async (request, reply) => {
      const ctx = ctxOf(request);
      if (!UUID.test(request.params.id)) return invalid(reply, ctx.requestId, { path: "id", message: "Invalid id" });
      const parsed = commentSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
      const publish = await canPublish(ctx);
      return run(reply, ctx.requestId, () => addTicketComment(db, ctx, request.params.id, parsed.data, publish), (r) => reply.status(201).send({ data: r.comment }));
    })
  );

  app.patch<{ Params: { id: string; commentId: string }; Body: unknown }>(
    "/tickets/:id/comments/:commentId/visibility",
    { preHandler: writeGate },
    async (request, rawReply) => {
      const reply = rawReply as unknown as Reply;
      const ctx = ctxOf(request);
      if (!UUID.test(request.params.id) || !UUID.test(request.params.commentId)) return invalid(reply, ctx.requestId, { path: "id", message: "Invalid id" });
      const parsed = visibilitySchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
      const publish = await canPublish(ctx);
      return run(reply, ctx.requestId, () => setCommentVisibility(db, ctx, request.params.id, request.params.commentId, parsed.data, publish), (r) => ({ data: r.comment }));
    }
  );

  /** Account Engineering tab on Customer 360: open count, max severity and the account's tickets. */
  app.get<IdParams>("/accounts/:id/tickets", { preHandler: accountReadGate }, async (request, rawReply) => {
    const reply = rawReply as unknown as Reply;
    const ctx = ctxOf(request);
    if (!UUID.test(request.params.id)) return invalid(reply, ctx.requestId, { path: "id", message: "Invalid id" });
    return run(reply, ctx.requestId, () => loadAccountTickets(db, ctx, request.params.id), (data) => ({ data }));
  });
}
