import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createAlertRule, deleteAlertRule, listAlertRules, updateAlertRule } from "../services/alert-rule.service.js";
import { errorResponse, HttpError } from "../utils/http.js";

const createSchema = z.object({
  signalType: z.string().min(1).max(100),
  minConfidence: z.number().min(0).max(1).nullable().optional(),
  enabled: z.boolean().optional(),
});

const updateSchema = z.object({
  signalType: z.string().min(1).max(100).optional(),
  minConfidence: z.number().min(0).max(1).nullable().optional(),
  enabled: z.boolean().optional(),
});

/**
 * R17.3 — alert rules: "signal type (+ min confidence) -> notify the owning SDR." Delivery
 * cadence (real-time vs. digest) is a per-user notification preference, set via the existing
 * R17.4 preferences endpoints, not here.
 */
export async function alertRuleRoutes(app: FastifyInstance) {
  app.get("/alert-rules", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Not authenticated", 401));
    if (!app.db) return reply.code(503).send(errorResponse("Database unavailable", 503));
    const rules = await listAlertRules(app.db, request.workspaceId);
    return reply.send({ data: rules });
  });

  app.post("/alert-rules", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Not authenticated", 401));
    if (!app.db) return reply.code(503).send(errorResponse("Database unavailable", 503));
    const input = createSchema.parse(request.body ?? {});
    try {
      const rule = await createAlertRule(app.db, request.workspaceId, input, request.userId);
      return reply.code(201).send({ data: rule });
    } catch (err) {
      if (err instanceof HttpError) return reply.code(err.statusCode).send(errorResponse(err.message, err.statusCode));
      throw err;
    }
  });

  app.patch("/alert-rules/:id", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Not authenticated", 401));
    if (!app.db) return reply.code(503).send(errorResponse("Database unavailable", 503));
    const { id } = request.params as { id: string };
    const input = updateSchema.parse(request.body ?? {});
    try {
      const rule = await updateAlertRule(app.db, request.workspaceId, id, input);
      return reply.send({ data: rule });
    } catch (err) {
      if (err instanceof HttpError) return reply.code(err.statusCode).send(errorResponse(err.message, err.statusCode));
      throw err;
    }
  });

  app.delete("/alert-rules/:id", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Not authenticated", 401));
    if (!app.db) return reply.code(503).send(errorResponse("Database unavailable", 503));
    const { id } = request.params as { id: string };
    await deleteAlertRule(app.db, request.workspaceId, id);
    return reply.code(204).send();
  });
}
