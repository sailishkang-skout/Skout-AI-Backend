import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { enrollSequenceSchema } from "@skout/shared";
import { buildSequenceService, STEP_TYPES, SEQUENCE_STATUSES } from "../services/sequence.service.js";
import { generateSequenceForWorkspace } from "../services/sequence-generate.service.js";
import { enqueueSequenceAdvanceJob } from "../workers/sequence-enrollment.queue.js";
import { dispatchWebhookEvent } from "../services/webhook.service.js";
import { HttpError } from "../utils/http.js";

const generateSequenceSchema = z.object({
  goal: z.string().min(1).max(600),
  listId: z.string().uuid().optional(),
  channels: z.array(z.enum(["email", "linkedin"])).min(1).max(2).optional(),
});

const fromStepsSchema = z.object({
  name: z.string().min(1).max(120),
  steps: z
    .array(
      z.object({
        stepType: z.enum(STEP_TYPES),
        delayDays: z.number().int().min(0).default(0),
        delayUnit: z.enum(["minutes", "hours", "days", "weeks"]).default("days"),
        linkedinAction: z.enum(["connect", "message"]).optional(),
        subject: z.string().max(500).nullable().optional(),
        bodyTemplate: z.string().nullable().optional(),
      })
    )
    .min(1)
    .max(12),
});

const createSequenceSchema = z.object({
  name: z.string().min(1).max(255),
});

const updateSequenceSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    status: z.enum(SEQUENCE_STATUSES).optional(),
  })
  .refine((d) => d.name !== undefined || d.status !== undefined, {
    message: "At least one of name or status is required",
  });

const DELAY_UNITS = ["minutes", "hours", "days", "weeks"] as const;
const LINKEDIN_ACTIONS = ["connect", "message"] as const;

const createStepSchema = z.object({
  stepType: z.enum(STEP_TYPES),
  delayDays: z.number().int().min(0).default(0),
  delayUnit: z.enum(DELAY_UNITS).default("days"),
  linkedinAction: z.enum(LINKEDIN_ACTIONS).optional(),
  subject: z.string().max(500).optional(),
  bodyTemplate: z.string().optional(),
});

const updateStepSchema = z
  .object({
    stepType: z.enum(STEP_TYPES).optional(),
    delayDays: z.number().int().min(0).optional(),
    delayUnit: z.enum(DELAY_UNITS).optional(),
    linkedinAction: z.enum(LINKEDIN_ACTIONS).nullable().optional(),
    subject: z.string().max(500).nullable().optional(),
    bodyTemplate: z.string().nullable().optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: "At least one field is required",
  });

const reorderStepsSchema = z.object({
  stepIds: z.array(z.string().uuid()).min(1),
});

export async function sequenceRoutes(app: FastifyInstance) {
  // GET /sequences — list all sequences for the workspace
  app.get("/sequences", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildSequenceService(app.db);
    if (!svc) return reply.send({ workspaceId, data: [], total: 0 });
    const data = await svc.listSequences(workspaceId);
    return reply.send({ workspaceId, data, total: data.length });
  });

  // POST /sequences — create a new draft sequence
  app.post("/sequences", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildSequenceService(app.db);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const { name } = createSequenceSchema.parse(request.body ?? {});
    const sequence = await svc.createSequence(workspaceId, name);
    return reply.status(201).send(sequence);
  });

  // POST /sequences/generate — AI-generate a draft multi-step cadence from a goal + list.
  app.post("/sequences/generate", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const body = generateSequenceSchema.parse(request.body ?? {});
    try {
      const sequence = await generateSequenceForWorkspace(app.db, app.config, workspaceId, body);
      return reply.status(201).send(sequence);
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message?: string };
      return reply
        .status(e.statusCode ?? 500)
        .send({ error: e.message ?? "sequence_generation_failed" });
    }
  });

  // POST /sequences/from-steps — persist a provided cadence as a draft sequence (chat "Apply").
  app.post("/sequences/from-steps", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildSequenceService(app.db);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const body = fromStepsSchema.parse(request.body ?? {});
    const sequence = await svc.createGeneratedSequence(workspaceId, body);
    return reply.status(201).send(sequence);
  });

  // GET /sequences/:id — fetch sequence with its steps
  app.get("/sequences/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildSequenceService(app.db);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const sequence = await svc.getSequenceById(workspaceId, id);
    if (!sequence) return reply.status(404).send({ error: "sequence_not_found" });
    return reply.send(sequence);
  });

  // GET /sequences/:id/analytics — per-step funnel metrics + enrollment summary
  app.get("/sequences/:id/analytics", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildSequenceService(app.db);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const analytics = await svc.getAnalytics(workspaceId, id);
    if (!analytics) return reply.status(404).send({ error: "sequence_not_found" });
    return reply.send(analytics);
  });

  // GET /sequences/:id/enrollments — live per-prospect enrollment status
  app.get("/sequences/:id/enrollments", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildSequenceService(app.db);
    if (!svc) return reply.send({ workspaceId, data: [], total: 0 });
    const data = await svc.listEnrollments(workspaceId, id);
    if (data === null) return reply.status(404).send({ error: "sequence_not_found" });
    return reply.send({ workspaceId, data, total: data.length });
  });

  // PATCH /sequences/:id — update name and/or status (lifecycle-validated)
  app.patch("/sequences/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildSequenceService(app.db);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const body = updateSequenceSchema.parse(request.body ?? {});
    try {
      const sequence = await svc.updateSequence(workspaceId, id, body);
      if (!sequence) return reply.status(404).send({ error: "sequence_not_found" });
      return reply.send(sequence);
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send({ error: err.message, details: err.details ?? null });
      }
      throw err;
    }
  });

  // DELETE /sequences/:id — delete sequence and all its steps (cascade)
  app.delete("/sequences/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildSequenceService(app.db);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    await svc.deleteSequence(workspaceId, id);
    return reply.status(204).send();
  });

  // PUT /sequences/:id/steps/reorder — reorder all steps (must come before /:stepId routes)
  app.put("/sequences/:id/steps/reorder", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildSequenceService(app.db);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const { stepIds } = reorderStepsSchema.parse(request.body ?? {});
    try {
      const steps = await svc.reorderSteps(workspaceId, id, stepIds);
      if (!steps) return reply.status(404).send({ error: "sequence_not_found" });
      return reply.send({ steps });
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send({ error: err.message, details: err.details ?? null });
      }
      throw err;
    }
  });

  // POST /sequences/:id/steps — add a step (appended at the end)
  app.post("/sequences/:id/steps", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildSequenceService(app.db);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const body = createStepSchema.parse(request.body ?? {});
    try {
      const step = await svc.addStep(workspaceId, id, body);
      if (!step) return reply.status(404).send({ error: "sequence_not_found" });
      return reply.status(201).send(step);
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send({ error: err.message, details: err.details ?? null });
      }
      throw err;
    }
  });

  // PATCH /sequences/:id/steps/:stepId — update step fields
  app.patch("/sequences/:id/steps/:stepId", async (request, reply) => {
    const { id, stepId } = request.params as { id: string; stepId: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildSequenceService(app.db);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const body = updateStepSchema.parse(request.body ?? {});
    try {
      const step = await svc.updateStep(workspaceId, id, stepId, body);
      if (!step) return reply.status(404).send({ error: "step_not_found" });
      return reply.send(step);
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send({ error: err.message, details: err.details ?? null });
      }
      throw err;
    }
  });

  // DELETE /sequences/:id/steps/:stepId — remove step and reorder remaining
  app.delete("/sequences/:id/steps/:stepId", async (request, reply) => {
    const { id, stepId } = request.params as { id: string; stepId: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildSequenceService(app.db);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const found = await svc.deleteStep(workspaceId, id, stepId);
    if (!found) return reply.status(404).send({ error: "sequence_not_found" });
    return reply.status(204).send();
  });

  // DELETE /sequences/:id/enrollments/:prospectId — unenroll a prospect
  app.delete("/sequences/:id/enrollments/:prospectId", async (request, reply) => {
    const { id, prospectId } = request.params as { id: string; prospectId: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildSequenceService(app.db);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const result = await svc.unenroll(workspaceId, id, prospectId);
    if (!result) return reply.status(404).send({ error: "enrollment_not_found" });
    return reply.status(204).send();
  });

  // GET /sequences/prospects/:prospectId/enrollments — get all enrollments for a prospect
  app.get("/sequences/prospects/:prospectId/enrollments", async (request, reply) => {
    const { prospectId } = request.params as { prospectId: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildSequenceService(app.db);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const enrollments = await svc.getProspectEnrollments(workspaceId, prospectId);
    return reply.send({ data: enrollments, total: enrollments.length });
  });

  // POST /sequences/:id/enroll — enroll prospects into a sequence
  app.post("/sequences/:id/enroll", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildSequenceService(app.db);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const body = enrollSequenceSchema.parse(request.body ?? {});
    try {
      const result = await svc.enroll(id, workspaceId, {
        prospectIds: body.prospectIds,
        listId: body.listId,
      });

      // Enqueue advance jobs — enrollment is already persisted, so queue failure is non-fatal
      for (const e of result.newEnrollments) {
        const delayMs =
          app.config.BYPASS_BUSINESS_HOURS || !e.firstStepScheduledAt
            ? 0
            : Math.max(0, e.firstStepScheduledAt.getTime() - Date.now());
        enqueueSequenceAdvanceJob(
          app.config,
          { enrollmentId: e.enrollmentId, workspaceId, prospectId: e.prospectId, sequenceId: id },
          delayMs
        ).catch((err: unknown) => {
          app.log.error({ err, enrollmentId: e.enrollmentId }, "Failed to enqueue advance job");
        });

        if (app.db) {
          dispatchWebhookEvent(app.db, app.config, "prospect.enrolled", workspaceId, {
            enrollmentId: e.enrollmentId,
            sequenceId: id,
            prospectId: e.prospectId,
          }).catch((err: unknown) => {
            app.log.warn({ err, enrollmentId: e.enrollmentId }, "webhook dispatch failed for prospect.enrolled");
          });
        }
      }

      return reply.status(202).send({
        enrolled: result.enrolled,
        skipped: result.skipped,
        total: result.total,
      });
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send({ error: err.message, details: err.details ?? null });
      }
      throw err;
    }
  });

  // GET /sequences/:id/lists — lists that have enrollments in this sequence
  app.get("/sequences/:id/lists", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildSequenceService(app.db);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const data = await svc.listEnrolledLists(workspaceId, id);
    if (!data) return reply.status(404).send({ error: "not_found" });
    return reply.send({ workspaceId, data, total: data.length });
  });
}
