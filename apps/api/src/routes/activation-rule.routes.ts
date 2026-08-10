import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createActivationRule,
  listActivationRules,
  listRuleRuns,
  reverseRuleRun,
  setActivationRuleEnabled,
  softDeleteActivationRule,
} from "../services/activation-rules.service.js";
import { errorResponse, HttpError } from "../utils/http.js";

const createSchema = z.object({
  name: z.string().min(1).max(255),
  scoreThreshold: z.number().int().min(0).max(100),
  signalType: z.string().max(100).optional(),
  targetAction: z.enum(["activate", "add_to_list", "enroll_sequence"]),
  targetId: z.string().min(1).max(255).optional(),
});

/** R13.4 — auto-activation rules: CRUD + run log/reversal. Matching+execution wiring is
 * documented as a follow-up in docs/tickets/phase-1-dependencies.md — this module owns the
 * rule store, the match decision, and the audit trail (every action logged + reversible),
 * per the acceptance criteria in phase-1-feature-work-plan.md R13.4. */
export async function activationRuleRoutes(app: FastifyInstance) {
  app.get("/activation-rules", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Not authenticated", 401));
    if (!app.db) return reply.code(503).send(errorResponse("Database unavailable", 503));
    const rules = await listActivationRules(app.db, request.workspaceId);
    return reply.send({ data: rules });
  });

  app.post("/activation-rules", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Not authenticated", 401));
    if (!app.db) return reply.code(503).send(errorResponse("Database unavailable", 503));
    const input = createSchema.parse(request.body ?? {});
    try {
      const rule = await createActivationRule(app.db, request.workspaceId, request.userId, input);
      return reply.code(201).send({ data: rule });
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.code(err.statusCode).send(errorResponse(err.message, err.statusCode));
      }
      throw err;
    }
  });

  app.patch("/activation-rules/:id/enabled", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Not authenticated", 401));
    if (!app.db) return reply.code(503).send(errorResponse("Database unavailable", 503));
    const { id } = request.params as { id: string };
    const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body ?? {});
    try {
      const rule = await setActivationRuleEnabled(app.db, request.workspaceId, id, enabled);
      if (!rule) return reply.code(404).send(errorResponse("Rule not found", 404));
      return reply.send({ data: rule });
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.code(err.statusCode).send(errorResponse(err.message, err.statusCode));
      }
      throw err;
    }
  });

  app.delete("/activation-rules/:id", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Not authenticated", 401));
    if (!app.db) return reply.code(503).send(errorResponse("Database unavailable", 503));
    const { id } = request.params as { id: string };
    const deleted = await softDeleteActivationRule(app.db, request.workspaceId, id);
    if (!deleted) return reply.code(404).send(errorResponse("Rule not found", 404));
    return reply.code(204).send();
  });

  app.get("/activation-rules/:id/runs", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Not authenticated", 401));
    if (!app.db) return reply.code(503).send(errorResponse("Database unavailable", 503));
    const { id } = request.params as { id: string };
    const runs = await listRuleRuns(app.db, request.workspaceId, id);
    return reply.send({ data: runs });
  });

  /** Manually reverse a rule's action (unenroll / remove from list) per the R13.4 AC. */
  app.post("/activation-rules/runs/:runId/reverse", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Not authenticated", 401));
    if (!app.db) return reply.code(503).send(errorResponse("Database unavailable", 503));
    const { runId } = request.params as { runId: string };
    const reversed = await reverseRuleRun(app.db, request.workspaceId, runId);
    if (!reversed) return reply.code(404).send(errorResponse("Run not found", 404));
    return reply.send({ data: { reversed: true } });
  });
}
