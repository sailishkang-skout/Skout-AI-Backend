import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getMemberPermissions } from "@skout/auth";
import { copsErrorBody, resolveCorrelationId } from "@skout/shared";
import { requireAnyCopsPermission } from "../services/cops-platform.service.js";
import { TicketError } from "../services/cops-tickets.service.js";
import { getIncidentDetail, linkTicketToIncident, publishIncidentCustomerUpdate, unlinkTicketFromIncident, updateIncident } from "../services/cops-incidents.service.js";

/**
 * COPS-12 incident linking (Bible p.54), next to the existing /incidents routes. Reads need
 * tickets:read, changes tickets:write, a customer-facing update tickets:send. Errors use the COPS
 * envelope.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const followUp = z.object({ text: z.string().min(1).max(500), done: z.boolean() });
const patchSchema = z
  .object({
    title: z.string().min(1).max(300).optional(),
    severity: z.enum(["low", "medium", "high", "critical"]).optional(),
    status: z.enum(["open", "investigating", "resolved"]).optional(),
    owner_id: z.string().uuid().nullable().optional(),
    started_at: z.string().datetime().nullable().optional(),
    ended_at: z.string().datetime().nullable().optional(),
    workaround: z.string().max(4000).nullable().optional(),
    root_cause: z.string().max(4000).nullable().optional(),
    follow_ups: z.array(followUp).max(50).optional(),
  })
  .strict();

type Reply = { status: (code: number) => Reply; send: (body: unknown) => unknown };

export async function copsIncidentsRoutes(app: FastifyInstance) {
  const db = () => {
    if (!app.db) throw new TicketError("NOT_FOUND", "Database not available");
    return app.db;
  };
  const perms = (ws: string, user: string) => getMemberPermissions(db(), ws, user);
  const readGate = requireAnyCopsPermission(["tickets:read"], perms);
  const writeGate = requireAnyCopsPermission(["tickets:write"], perms);
  const ctxOf = (r: { workspaceId?: string; userId?: string; headers: Record<string, unknown> }) => ({ workspaceId: r.workspaceId!, userId: r.userId!, requestId: resolveCorrelationId(r.headers["x-request-id"] as string | undefined) });

  async function run(reply: Reply, requestId: string, fn: () => Promise<unknown>, status = 200) {
    try {
      const data = await fn();
      return reply.status(status).send(data === undefined ? null : { data });
    } catch (error) {
      if (error instanceof TicketError) return reply.status(error.status).send(copsErrorBody({ code: error.code, message: error.message, requestId, details: error.details }));
      throw error;
    }
  }
  const invalid = (reply: Reply, requestId: string, err: z.ZodError | string) =>
    reply.status(422).send(
      copsErrorBody({
        code: "VALIDATION_FAILED",
        message: typeof err === "string" ? err : (err.issues[0]?.message ?? "Invalid request"),
        requestId,
        details: { fields: typeof err === "string" ? [{ path: "id", message: err }] : err.issues.map((i) => ({ path: i.path.join(".") || "body", message: i.message })) },
      })
    );

  type P = { Params: { id: string; ticketId?: string }; Body: unknown };

  app.get<P>("/incidents/:id/detail", { preHandler: readGate }, async (request, raw) => {
    const reply = raw as unknown as Reply;
    const ctx = ctxOf(request);
    if (!UUID.test(request.params.id)) return invalid(reply, ctx.requestId, "Invalid id");
    return run(reply, ctx.requestId, () => getIncidentDetail(db(), ctx.workspaceId, request.params.id));
  });

  app.patch<P>("/incidents/:id", { preHandler: writeGate }, async (request, raw) => {
    const reply = raw as unknown as Reply;
    const ctx = ctxOf(request);
    if (!UUID.test(request.params.id)) return invalid(reply, ctx.requestId, "Invalid id");
    const parsed = patchSchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
    return run(reply, ctx.requestId, () => updateIncident(db(), ctx, request.params.id, parsed.data));
  });

  app.post<P>("/incidents/:id/tickets", { preHandler: writeGate }, async (request, raw) => {
    const reply = raw as unknown as Reply;
    const ctx = ctxOf(request);
    const parsed = z.object({ ticket_id: z.string().uuid() }).safeParse(request.body ?? {});
    if (!UUID.test(request.params.id)) return invalid(reply, ctx.requestId, "Invalid id");
    if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
    return run(reply, ctx.requestId, () => linkTicketToIncident(db(), ctx, request.params.id, parsed.data.ticket_id), 201);
  });

  app.delete<P>("/incidents/:id/tickets/:ticketId", { preHandler: writeGate }, async (request, raw) => {
    const reply = raw as unknown as Reply;
    const ctx = ctxOf(request);
    if (!UUID.test(request.params.id) || !UUID.test(request.params.ticketId ?? "")) return invalid(reply, ctx.requestId, "Invalid id");
    return run(reply, ctx.requestId, async () => void (await unlinkTicketFromIncident(db(), ctx, request.params.id, request.params.ticketId!)), 204);
  });

  app.post<P>("/incidents/:id/customer-update", { preHandler: writeGate }, async (request, raw) => {
    const reply = raw as unknown as Reply;
    const ctx = ctxOf(request);
    if (!UUID.test(request.params.id)) return invalid(reply, ctx.requestId, "Invalid id");
    const parsed = z.object({ body: z.string().trim().min(1).max(4000) }).safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
    const canPublish = (await perms(ctx.workspaceId, ctx.userId)).includes("tickets:send");
    return run(reply, ctx.requestId, () => publishIncidentCustomerUpdate(db(), ctx, request.params.id, parsed.data.body, canPublish));
  });
}
