import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { enrollSequenceSchema } from "@skout/shared";
import {
  buildSequenceService,
  STEP_TYPES,
  SEQUENCE_STATUSES,
  SEQUENCE_SOURCES,
  SEQUENCE_MODES,
  CONDITION_TYPES,
  LINKEDIN_ACTIONS,
} from "../services/sequence.service.js";
import { generateSequenceForWorkspace } from "../services/sequence-generate.service.js";
import { SEQUENCE_TEMPLATES, getSequenceTemplate } from "../services/sequence-templates.js";
import { conditionExpressionSchema } from "../services/sequence-condition.js";
import { enqueueSequenceAdvanceJob } from "../workers/sequence-enrollment.queue.js";
import { dispatchWebhookEvent } from "../services/webhook.service.js";
import { HttpError } from "../utils/http.js";
import { buildConsentService } from "../services/consent.service.js";

const generateSequenceSchema = z.object({
  goal: z.string().min(1).max(600),
  listId: z.string().uuid().optional(),
  channels: z.array(z.enum(["email", "linkedin"])).min(1).max(2).optional(),
});

const fromStepsSchema = z.object({
  name: z.string().min(1).max(120),
  source: z.enum(SEQUENCE_SOURCES).optional(),
  templateKey: z.string().max(80).optional(),
  steps: z
    .array(
      z.object({
        stepType: z.enum(STEP_TYPES),
        delayDays: z.number().int().min(0).default(0),
        delayUnit: z.enum(["minutes", "hours", "days", "weeks"]).default("days"),
        linkedinAction: z.enum(LINKEDIN_ACTIONS).optional(),
        subject: z.string().max(500).nullable().optional(),
        bodyTemplate: z.string().nullable().optional(),
        conditionType: z.enum(CONDITION_TYPES).nullable().optional(),
        conditionExpression: conditionExpressionSchema.nullable().optional(),
        conditionWaitDays: z.number().int().min(0).max(30).optional(),
        branch: z.enum(["yes", "no"]).nullable().optional(),
        goalLabel: z.string().max(200).nullable().optional(),
      })
    )
    .min(1)
    .max(24),
});

const createSequenceSchema = z.object({
  name: z.string().min(1).max(255),
  source: z.enum(SEQUENCE_SOURCES).optional(),
  mode: z.enum(SEQUENCE_MODES).optional(),
});

const updateSequenceSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    status: z.enum(SEQUENCE_STATUSES).optional(),
    mode: z.enum(SEQUENCE_MODES).optional(),
  })
  .refine((d) => d.name !== undefined || d.status !== undefined || d.mode !== undefined, {
    message: "At least one of name, status, or mode is required",
  });

const DELAY_UNITS = ["minutes", "hours", "days", "weeks"] as const;

const variantSchema = z.object({
  variantKey: z.enum(["A", "B", "C"]),
  subject: z.string().max(500).nullable().optional(),
  bodyTemplate: z.string().nullable().optional(),
  weight: z.number().int().min(0).max(100).optional(),
  enabled: z.boolean().optional(),
});

const createStepSchema = z.object({
  stepType: z.enum(STEP_TYPES),
  delayDays: z.number().int().min(0).default(0),
  delayUnit: z.enum(DELAY_UNITS).default("days"),
  linkedinAction: z.enum(LINKEDIN_ACTIONS).optional(),
  subject: z.string().max(500).optional(),
  bodyTemplate: z.string().optional(),
  conditionType: z.enum(CONDITION_TYPES).nullable().optional(),
  conditionExpression: conditionExpressionSchema.nullable().optional(),
  conditionWaitDays: z.number().int().min(0).max(30).optional(),
  yesNextStepId: z.string().uuid().nullable().optional(),
  noNextStepId: z.string().uuid().nullable().optional(),
  parentStepId: z.string().uuid().nullable().optional(),
  branch: z.enum(["yes", "no"]).nullable().optional(),
  goalLabel: z.string().max(200).nullable().optional(),
  variants: z.array(variantSchema).max(3).optional(),
});

const updateStepSchema = z
  .object({
    stepType: z.enum(STEP_TYPES).optional(),
    delayDays: z.number().int().min(0).optional(),
    delayUnit: z.enum(DELAY_UNITS).optional(),
    linkedinAction: z.enum(LINKEDIN_ACTIONS).nullable().optional(),
    subject: z.string().max(500).nullable().optional(),
    bodyTemplate: z.string().nullable().optional(),
    conditionType: z.enum(CONDITION_TYPES).nullable().optional(),
    conditionExpression: conditionExpressionSchema.nullable().optional(),
    conditionWaitDays: z.number().int().min(0).max(30).optional(),
    yesNextStepId: z.string().uuid().nullable().optional(),
    noNextStepId: z.string().uuid().nullable().optional(),
    parentStepId: z.string().uuid().nullable().optional(),
    branch: z.enum(["yes", "no"]).nullable().optional(),
    goalLabel: z.string().max(200).nullable().optional(),
    variants: z.array(variantSchema).max(3).optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: "At least one field is required",
  });

const reorderStepsSchema = z.object({
  stepIds: z.array(z.string().uuid()).min(1),
});

export async function sequenceRoutes(app: FastifyInstance) {
  // GET /sequences — list sequences for the workspace, optionally filtered by status
  app.get("/sequences", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const { status } = request.query as { status?: string };
    const svc = buildSequenceService(app.db);
    if (!svc) return reply.send({ workspaceId, data: [], total: 0 });
    const data = await svc.listSequences(workspaceId, status);
    return reply.send({ workspaceId, data, total: data.length });
  });

  // POST /sequences — create a new draft sequence
  app.post("/sequences", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildSequenceService(app.db);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const { name, source, mode } = createSequenceSchema.parse(request.body ?? {});
    const sequence = await svc.createSequence(workspaceId, name, { source, mode });
    return reply.status(201).send(sequence);
  });

  app.get("/sequences/experiments", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildSequenceService(app.db);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const data = await svc.listExperiments(workspaceId);
    return reply.send({ data, total: data.length });
  });

  app.post("/sequences/experiments", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildSequenceService(app.db);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const body = z
      .object({
        name: z.string().min(1).max(255),
        sequenceAId: z.string().uuid().optional(),
        sequenceBId: z.string().uuid().optional(),
        fromTemplates: z.boolean().optional(),
        weightA: z.number().int().min(0).max(100).optional(),
        weightB: z.number().int().min(0).max(100).optional(),
        primaryMetric: z.enum(["positive_reply", "meeting_booked", "completed"]).optional(),
        durationDays: z.number().int().min(1).max(180).optional(),
      })
      .parse(request.body ?? {});

    let sequenceAId = body.sequenceAId;
    let sequenceBId = body.sequenceBId;
    if (body.fromTemplates || !sequenceAId || !sequenceBId) {
      const tplA = getSequenceTemplate("saas-vp-email");
      const tplB = getSequenceTemplate("linkedin-first-connect");
      if (!tplA || !tplB) return reply.status(500).send({ error: "templates_missing" });
      const seqA = await svc.createGeneratedSequence(workspaceId, {
        name: `${body.name} — A`,
        source: "template",
        templateKey: tplA.key,
        mode: "A",
        steps: tplA.steps,
      });
      const seqB = await svc.createGeneratedSequence(workspaceId, {
        name: `${body.name} — B`,
        source: "template",
        templateKey: tplB.key,
        mode: "B",
        steps: tplB.steps,
      });
      sequenceAId = seqA.id;
      sequenceBId = seqB.id;
    }

    const experiment = await svc.createExperiment(workspaceId, {
      name: body.name,
      sequenceAId: sequenceAId!,
      sequenceBId: sequenceBId!,
      weightA: body.weightA,
      weightB: body.weightB,
      primaryMetric: body.primaryMetric,
      durationDays: body.durationDays,
    });
    return reply.status(201).send({
      ...experiment,
      sequenceAId,
      sequenceBId,
    });
  });

  app.get("/sequences/experiments/:id", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const { id } = request.params as { id: string };
    const svc = buildSequenceService(app.db);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const experiment = await svc.getExperiment(workspaceId, id);
    if (!experiment) return reply.status(404).send({ error: "experiment_not_found" });
    return reply.send(experiment);
  });

  app.patch("/sequences/experiments/:id", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const { id } = request.params as { id: string };
    const svc = buildSequenceService(app.db);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const body = z
      .object({
        name: z.string().min(1).max(255).optional(),
        status: z.enum(["draft", "running", "paused", "completed"]).optional(),
        weightA: z.number().int().min(0).max(100).optional(),
        weightB: z.number().int().min(0).max(100).optional(),
        primaryMetric: z.enum(["positive_reply", "meeting_booked", "completed"]).optional(),
        durationDays: z.number().int().min(1).max(180).optional(),
      })
      .parse(request.body ?? {});
    try {
      const updated = await svc.updateExperiment(workspaceId, id, body);
      if (!updated) return reply.status(404).send({ error: "experiment_not_found" });
      return reply.send(updated);
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send({ error: err.message, details: err.details ?? null });
      }
      throw err;
    }
  });

  app.get("/sequences/experiments/:id/analytics", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const { id } = request.params as { id: string };
    const svc = buildSequenceService(app.db);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const analytics = await svc.getExperimentAnalytics(workspaceId, id);
    if (!analytics) return reply.status(404).send({ error: "experiment_not_found" });
    return reply.send(analytics);
  });

  app.post("/sequences/experiments/:id/enroll", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const { id } = request.params as { id: string };
    const svc = buildSequenceService(app.db);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const body = enrollSequenceSchema.parse(request.body ?? {});
    try {
      const experiment = await svc.getExperiment(workspaceId, id);
      if (!experiment) return reply.status(404).send({ error: "experiment_not_found" });
      const result = await svc.enrollExperiment(workspaceId, id, {
        prospectIds: body.prospectIds,
        listId: body.listId,
      });
      for (const e of result.newEnrollments) {
        const delayMs =
          app.config.BYPASS_BUSINESS_HOURS || !e.firstStepScheduledAt
            ? 0
            : Math.max(0, e.firstStepScheduledAt.getTime() - Date.now());
        enqueueSequenceAdvanceJob(
          app.config,
          {
            enrollmentId: e.enrollmentId,
            workspaceId,
            prospectId: e.prospectId,
            sequenceId: e.variant === "A" ? experiment.sequenceAId : experiment.sequenceBId,
          },
          delayMs
        ).catch((err: unknown) => {
          app.log.error({ err, enrollmentId: e.enrollmentId }, "Failed to enqueue experiment advance job");
        });
      }
      return reply.status(202).send({
        enrolled: result.enrolled,
        enrolledA: result.enrolledA,
        enrolledB: result.enrolledB,
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

  app.get("/sequences/templates", async (_request, reply) => {
    return reply.send({
      data: SEQUENCE_TEMPLATES.map(({ key, name, description, channels, mode }) => ({
        key,
        name,
        description,
        channels,
        mode,
      })),
      total: SEQUENCE_TEMPLATES.length,
    });
  });

  app.post("/sequences/from-template", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildSequenceService(app.db);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const body = z
      .object({
        key: z.string().min(1),
        name: z.string().min(1).max(255).optional(),
        mode: z.enum(SEQUENCE_MODES).optional(),
      })
      .parse(request.body ?? {});
    const template = getSequenceTemplate(body.key);
    if (!template) return reply.status(404).send({ error: "template_not_found" });
    const sequence = await svc.createGeneratedSequence(workspaceId, {
      name: body.name ?? template.name,
      source: "template",
      templateKey: template.key,
      mode: body.mode ?? template.mode,
      steps: template.steps,
    });
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

  app.get("/sequences/:id/versions", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildSequenceService(app.db);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const data = await svc.listVersions(workspaceId, id);
    if (!data) return reply.status(404).send({ error: "sequence_not_found" });
    return reply.send({ data, total: data.length });
  });

  app.post("/sequences/:id/versions", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildSequenceService(app.db);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    try {
      const version = await svc.publishVersion(workspaceId, id);
      return reply.status(201).send(version);
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send({ error: err.message, details: err.details ?? null });
      }
      throw err;
    }
  });

  app.get("/sequences/:id/events", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildSequenceService(app.db);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const q = request.query as { enrollmentId?: string; limit?: string };
    const data = await svc.listEvents(workspaceId, id, {
      enrollmentId: q.enrollmentId,
      limit: q.limit ? Number(q.limit) : undefined,
    });
    if (!data) return reply.status(404).send({ error: "sequence_not_found" });
    return reply.send({ data, total: data.length });
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

    // §5.1 / §16 — fail-closed consent gate (CONSENT_ENFORCEMENT_ENABLED)
    if (app.config.CONSENT_ENFORCEMENT_ENABLED && app.db && body.prospectIds?.length) {
      const consentSvc = buildConsentService(app.db);
      if (consentSvc) {
        const missing: string[] = [];
        for (const prospectId of body.prospectIds) {
          const ok = await consentSvc.hasActive(workspaceId, "prospect", prospectId, "email");
          if (!ok) missing.push(prospectId);
        }
        if (missing.length > 0) {
          if (body.consentBasis) {
            for (const prospectId of missing) {
              await consentSvc.record({
                workspaceId,
                subjectType: "prospect",
                subjectId: prospectId,
                type: "email",
                basis: body.consentBasis,
                recordedBy: request.userId,
              });
            }
          } else {
            return reply.status(403).send({
              error: "consent_required",
              message: "Active email consent is required before enrolling these prospects.",
              missingConsentProspectIds: missing,
            });
          }
        }
      }
    }

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
