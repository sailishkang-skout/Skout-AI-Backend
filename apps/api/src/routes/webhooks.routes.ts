import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { WEBHOOK_EVENT_TYPES, buildWebhookService } from "../services/webhook.service.js";

const eventTypeEnum = z.enum(WEBHOOK_EVENT_TYPES);

const createEndpointSchema = z.object({
  url: z.string().url("Must be a valid URL"),
  description: z.string().max(255).optional(),
  eventTypes: z.array(eventTypeEnum).min(1, "At least one event type required"),
});

const updateEndpointSchema = z
  .object({
    url: z.string().url("Must be a valid URL").optional(),
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
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildWebhookService(app.db);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const data = await svc.listEndpoints(workspaceId);
    return reply.send({ data, total: data.length });
  });

  /** POST /webhooks/endpoints */
  app.post("/webhooks/endpoints", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildWebhookService(app.db);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const body = createEndpointSchema.parse(request.body);
    const endpoint = await svc.createEndpoint(workspaceId, body);
    return reply.status(201).send(endpoint);
  });

  /** GET /webhooks/endpoints/:id */
  app.get("/webhooks/endpoints/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildWebhookService(app.db);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const endpoint = await svc.getEndpoint(id, workspaceId);
    if (!endpoint) return reply.status(404).send({ error: "not_found" });
    return reply.send(endpoint);
  });

  /** PATCH /webhooks/endpoints/:id */
  app.patch("/webhooks/endpoints/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildWebhookService(app.db);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const body = updateEndpointSchema.parse(request.body);
    const endpoint = await svc.updateEndpoint(id, workspaceId, body);
    if (!endpoint) return reply.status(404).send({ error: "not_found" });
    return reply.send(endpoint);
  });

  /** DELETE /webhooks/endpoints/:id */
  app.delete("/webhooks/endpoints/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildWebhookService(app.db);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const deleted = await svc.deleteEndpoint(id, workspaceId);
    if (!deleted) return reply.status(404).send({ error: "not_found" });
    return reply.status(204).send();
  });

  /** POST /webhooks/endpoints/:id/rotate-secret */
  app.post("/webhooks/endpoints/:id/rotate-secret", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildWebhookService(app.db);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const newSecret = await svc.rotateSecret(id, workspaceId);
    if (!newSecret) return reply.status(404).send({ error: "not_found" });
    return reply.send({ secret: newSecret });
  });

  /** GET /webhooks/endpoints/:id/deliveries */
  app.get("/webhooks/endpoints/:id/deliveries", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
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
