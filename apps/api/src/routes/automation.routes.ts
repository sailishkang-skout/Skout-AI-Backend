import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@skout/db";
import { errorResponse, HttpError } from "../utils/http.js";
import { AutomationService } from "../services/automation.service.js";
import { createAutomationRun, getRun, listRuns } from "../services/automation-run.service.js";
import { enqueueAutomationRunAdvance } from "../workers/automation-run.queue.js";
import type { AutomationGraph } from "../services/automation-graph.js";

const { automations } = schema;

const graphSchema = z.object({
  nodes: z.array(z.object({ id: z.string(), type: z.string(), config: z.record(z.string(), z.unknown()) })),
  edges: z.array(z.object({ id: z.string(), source: z.string(), target: z.string(), branch: z.enum(["true", "false"]).optional() })),
});

/** §8.14 — Workflow Studio: automation CRUD, versioning, and run triggering. */
export async function automationRoutes(app: FastifyInstance) {
  function db() {
    if (!app.db) throw new HttpError("Database not available", 500);
    return app.db;
  }

  app.post("/automations", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const body = z.object({ name: z.string().min(1).max(200), description: z.string().max(2000).optional() }).parse(request.body ?? {});
    const svc = new AutomationService(db());
    const auto = await svc.createAutomation(request.workspaceId, { ...body, createdBy: request.userId });
    return reply.code(201).send({ data: auto });
  });

  app.get("/automations", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const svc = new AutomationService(db());
    return reply.send({ data: await svc.listAutomations(request.workspaceId) });
  });

  app.get("/automations/:id", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const svc = new AutomationService(db());
    return reply.send({ data: await svc.getAutomation(request.workspaceId, id) });
  });

  app.post("/automations/:id/versions", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ graph: graphSchema }).parse(request.body ?? {});
    const svc = new AutomationService(db());
    const version = await svc.saveDraftVersion(request.workspaceId, id, body.graph as AutomationGraph);
    return reply.code(201).send({ data: version });
  });

  app.post("/automations/:id/versions/publish", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ graph: graphSchema }).parse(request.body ?? {});
    const svc = new AutomationService(db());
    const version = await svc.publishVersion(request.workspaceId, id, body.graph as AutomationGraph, request.userId);
    return reply.code(201).send({ data: version });
  });

  app.get("/automations/:id/versions", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const svc = new AutomationService(db());
    return reply.send({ data: await svc.listVersions(request.workspaceId, id) });
  });

  app.post("/automations/:id/run", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ isSimulation: z.boolean().optional() }).parse(request.body ?? {});

    const svc = new AutomationService(db());
    const version = await svc.getLatestPublishedVersion(id);
    if (!version) return reply.code(422).send(errorResponse("Automation has no published version", 422));

    const run = await createAutomationRun(db(), {
      automationId: id,
      automationVersionId: version.id,
      workspaceId: request.workspaceId,
      triggerType: "manual",
      triggerRef: request.userId,
      correlationId: randomUUID(),
      graph: version.graph as AutomationGraph,
      idempotencyKey: `manual:${randomUUID()}`,
      isSimulation: body.isSimulation ?? false,
    });
    // Fire-and-forget, same pattern as enqueueSequenceAdvanceJob's call sites — a Redis hiccup
    // shouldn't block this response; the run stays "pending" and a later retry/backfill picks it
    // up rather than the request hanging on a queue connection.
    enqueueAutomationRunAdvance(app.config, { automationRunId: run.id, workspaceId: request.workspaceId }).catch((err: unknown) => {
      app.log.error({ err, runId: run.id }, "Failed to enqueue automation run advance job");
    });
    return reply.code(202).send({ data: run });
  });

  /**
   * Public webhook trigger — the n8n-equivalent generic connector entry point. Not
   * signature-verified in this slice (no per-automation secret config UI exists yet); every run
   * created this way is flagged `verified: false` in the response rather than silently treated as
   * trusted. Wiring real per-automation secret verification (via automation-secrets.service.ts +
   * inbound-webhook-verify.ts's HMAC helper) is explicit follow-on work, not a silent gap.
   */
  app.post("/automations/:id/webhook/:token", async (request, reply) => {
    const { id, token } = z.object({ id: z.string().uuid(), token: z.string().min(1) }).parse(request.params);

    // Public route — no request.workspaceId to scope by, so recover the owning workspace
    // directly from the automation row itself.
    const [auto] = await db().select({ workspaceId: automations.workspaceId }).from(automations).where(eq(automations.id, id)).limit(1);
    if (!auto) return reply.code(404).send(errorResponse("Automation not found", 404));

    const svc = new AutomationService(db());
    const version = await svc.getLatestPublishedVersion(id);
    if (!version) return reply.code(422).send(errorResponse("Automation has no published version", 422));

    const run = await createAutomationRun(db(), {
      automationId: id,
      automationVersionId: version.id,
      workspaceId: auto.workspaceId,
      triggerType: "webhook",
      triggerRef: token,
      correlationId: randomUUID(),
      graph: version.graph as AutomationGraph,
      idempotencyKey: `webhook:${token}:${Date.now()}`,
    });
    enqueueAutomationRunAdvance(app.config, { automationRunId: run.id, workspaceId: run.workspaceId }).catch((err: unknown) => {
      app.log.error({ err, runId: run.id }, "Failed to enqueue automation run advance job");
    });
    return reply.code(202).send({ data: { runId: run.id, verified: false } });
  });

  app.get("/automations/:id/runs", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return reply.send({ data: await listRuns(db(), request.workspaceId, id) });
  });

  app.get("/automations/runs/:runId", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const { runId } = z.object({ runId: z.string().uuid() }).parse(request.params);
    return reply.send({ data: await getRun(db(), request.workspaceId, runId) });
  });
}
