import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { schema } from "@skout/db";
import { and, eq } from "drizzle-orm";
import { WEBHOOK_EVENT_TYPES, buildWebhookService } from "../services/webhook.service.js";
import { webhookUrlProblem } from "../services/webhook-url-guard.js";
import { deliverOnce } from "../workers/webhook-delivery.worker.js";
import { requireWorkspaceId } from "../utils/http.js";

// The save-time URL check lives in services/webhook-url-guard.ts (PAPI-071), shared with the
// public API; re-exported here for existing imports.
export { webhookUrlProblem };
const publicHttpsUrl = z.string().superRefine((v, ctx) => {
  const problem = webhookUrlProblem(v);
  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
});

/** Creating, changing, deleting or testing an endpoint is for workspace owners and admins. */
async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  const role = (request as FastifyRequest & { role?: string }).role;
  if (!role || !["owner", "admin"].includes(role)) {
    return reply.status(403).send({ error: "forbidden", message: "Only workspace owners and admins can manage webhooks" });
  }
}

const eventTypeEnum = z.enum(WEBHOOK_EVENT_TYPES);

const createEndpointSchema = z.object({
  url: publicHttpsUrl,
  description: z.string().max(255).optional(),
  eventTypes: z.array(eventTypeEnum).min(1, "At least one event type required"),
});

const updateEndpointSchema = z
  .object({
    url: publicHttpsUrl.optional(),
    description: z.string().max(255).nullable().optional(),
    enabled: z.boolean().optional(),
    eventTypes: z.array(eventTypeEnum).min(1).optional(),
  })
  .refine(
    (d) =>
      d.url !== undefined ||
      d.description !== undefined ||
      d.enabled !== undefined ||
      d.eventTypes !== undefined,
    { message: "At least one field is required" }
  );

export async function webhookRoutes(app: FastifyInstance) {
  /** GET /webhooks/event-types — list all supported event types */
  app.get("/webhooks/event-types", async (_request, reply) => {
    return reply.send({ data: WEBHOOK_EVENT_TYPES });
  });

  /** GET /webhooks/endpoints */
  app.get("/webhooks/endpoints", async (request, reply) => {
    const workspaceId = requireWorkspaceId(request);
    const svc = buildWebhookService(app.db);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const data = await svc.listEndpoints(workspaceId);
    return reply.send({ data, total: data.length });
  });

  /** POST /webhooks/endpoints */
  app.post("/webhooks/endpoints", { preHandler: requireAdmin }, async (request, reply) => {
    const workspaceId = requireWorkspaceId(request);
    const svc = buildWebhookService(app.db);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const body = createEndpointSchema.parse(request.body);
    const endpoint = await svc.createEndpoint(workspaceId, body);
    return reply.status(201).send(endpoint);
  });

  /** GET /webhooks/endpoints/:id */
  app.get("/webhooks/endpoints/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = requireWorkspaceId(request);
    const svc = buildWebhookService(app.db);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const endpoint = await svc.getEndpoint(id, workspaceId);
    if (!endpoint) return reply.status(404).send({ error: "not_found" });
    return reply.send(endpoint);
  });

  /** PATCH /webhooks/endpoints/:id */
  app.patch("/webhooks/endpoints/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = requireWorkspaceId(request);
    const svc = buildWebhookService(app.db);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const body = updateEndpointSchema.parse(request.body);
    const endpoint = await svc.updateEndpoint(id, workspaceId, body);
    if (!endpoint) return reply.status(404).send({ error: "not_found" });
    return reply.send(endpoint);
  });

  /** DELETE /webhooks/endpoints/:id */
  app.delete("/webhooks/endpoints/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = requireWorkspaceId(request);
    const svc = buildWebhookService(app.db);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const deleted = await svc.deleteEndpoint(id, workspaceId);
    if (!deleted) return reply.status(404).send({ error: "not_found" });
    return reply.status(204).send();
  });

  /** POST /webhooks/endpoints/:id/rotate-secret */
  app.post("/webhooks/endpoints/:id/rotate-secret", { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = requireWorkspaceId(request);
    const svc = buildWebhookService(app.db);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const newSecret = await svc.rotateSecret(id, workspaceId);
    if (!newSecret) return reply.status(404).send({ error: "not_found" });
    return reply.send({ secret: newSecret });
  });

  /**
   * POST /webhooks/endpoints/:id/test: send one signed `webhook.test` event now and report what
   * the receiver answered. Not queued and not retried, so the admin sees the result at once.
   */
  app.post("/webhooks/endpoints/:id/test", { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = requireWorkspaceId(request);
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const [ep] = await app.db
      .select({ url: schema.webhookEndpoints.url, secret: schema.webhookEndpoints.secret })
      .from(schema.webhookEndpoints)
      .where(and(eq(schema.webhookEndpoints.id, id), eq(schema.webhookEndpoints.workspaceId, workspaceId)))
      .limit(1);
    if (!ep) return reply.status(404).send({ error: "not_found" });
    const problem = webhookUrlProblem(ep.url);
    if (problem) return reply.status(422).send({ error: "invalid_url", message: `This endpoint's address is not allowed: ${problem}` });
    const deliveryId = randomUUID();
    try {
      const r = await deliverOnce(deliveryId, {
        deliveryId,
        endpointId: id,
        url: ep.url,
        secret: ep.secret,
        workspaceId,
        eventType: "webhook.test" as never,
        eventId: randomUUID(),
        attempt: 1,
        payload: { message: "Test event from Skout. You can ignore it." },
      });
      return reply.send({ ok: r.statusCode >= 200 && r.statusCode < 300, statusCode: r.statusCode, durationMs: r.durationMs, responseBody: r.responseBody.slice(0, 300) });
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      return reply.send({ ok: false, statusCode: null, durationMs: null, error: aborted ? "No answer within 10 seconds" : "Could not reach the endpoint" });
    }
  });

  /** GET /webhooks/endpoints/:id/deliveries */
  app.get("/webhooks/endpoints/:id/deliveries", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = requireWorkspaceId(request);
    const svc = buildWebhookService(app.db);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });

    const endpoint = await svc.getEndpoint(id, workspaceId);
    if (!endpoint) return reply.status(404).send({ error: "not_found" });

    const query = (request.query as { limit?: string });
    const limit = Math.min(parseInt(query.limit ?? "50", 10) || 50, 200);
    const deliveries = await svc.listDeliveries(id, workspaceId, limit);
    return reply.send({ data: deliveries, total: deliveries.length });
  });
}
