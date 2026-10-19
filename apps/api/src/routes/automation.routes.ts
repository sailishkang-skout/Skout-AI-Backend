import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { z } from "zod";
import { schema, scopedById } from "@skout/db";
import { errorResponse, HttpError } from "../utils/http.js";
import { AutomationService } from "../services/automation.service.js";
import { createAutomationRun, getRun, listRuns, retryFailedSteps, RUN_SUBJECT_TYPES, type RunSubjectType } from "../services/automation-run.service.js";
import { enqueueAutomationRunAdvance } from "../workers/automation-run.queue.js";
import type { AutomationGraph } from "../services/automation-graph.js";
import { validateAutomationGraph } from "../services/automation-graph-validate.js";
import { workspaceManageGate } from "./crm-admin-gate.js";

const { automations, companies, contacts, deals } = schema;

const subjectSchema = z.object({ type: z.enum(RUN_SUBJECT_TYPES), id: z.string().uuid() });
const SUBJECT_TABLES = { account: companies, contact: contacts, deal: deals } as const;

/** 422 unless the run's subject is a record in this workspace. */
async function assertSubjectInWorkspace(db: Db, workspaceId: string, subject: { type: RunSubjectType; id: string }) {
  const table = SUBJECT_TABLES[subject.type];
  const [row] = await db.select({ id: table.id }).from(table).where(scopedById(table, workspaceId, subject.id)).limit(1);
  if (!row) throw new HttpError("automation_run_subject_not_found", 422);
}

const runHistoryQuery = z.object({
  version: z.coerce.number().int().min(0).optional(),
  account_id: z.string().uuid().optional(),
  status: z.enum(["pending", "running", "awaiting_approval", "succeeded", "failed", "cancelled"]).optional(),
  before: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

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
  // COPS-10: building, publishing and running workflows is for Owner and Admin; members can read.
  const manage = { preHandler: workspaceManageGate(app) };

  /** Throws 422 with every issue when the graph uses a node type outside the allowlist or is incomplete. */
  function checkGraph(graph: AutomationGraph, strict: boolean) {
    const issues = validateAutomationGraph(graph, { strict });
    if (issues.length) throw new HttpError("automation_graph_invalid", 422, { issues });
  }

  app.post("/automations", manage, async (request, reply) => {
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

  app.patch("/automations/:id", manage, async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ name: z.string().min(1).max(200).optional(), description: z.string().max(2000).optional() }).parse(request.body ?? {});
    const svc = new AutomationService(db());
    const auto = await svc.updateAutomation(request.workspaceId, id, body);
    return reply.send({ data: auto });
  });

  app.post("/automations/:id/versions", manage, async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ graph: graphSchema }).parse(request.body ?? {});
    const svc = new AutomationService(db());
    checkGraph(body.graph as AutomationGraph, false);
    const version = await svc.saveDraftVersion(request.workspaceId, id, body.graph as AutomationGraph);
    return reply.code(201).send({ data: version });
  });

  app.post("/automations/:id/versions/publish", manage, async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ graph: graphSchema }).parse(request.body ?? {});
    const svc = new AutomationService(db());
    checkGraph(body.graph as AutomationGraph, true);
    const version = await svc.publishVersion(request.workspaceId, id, body.graph as AutomationGraph, request.userId);
    return reply.code(201).send({ data: version });
  });

  /** COPS-10: makes an earlier version live again, as the next version. In-flight runs keep theirs. */
  app.post("/automations/:id/versions/:version/rollback", manage, async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const { id, version } = z.object({ id: z.string().uuid(), version: z.coerce.number().int().min(1) }).parse(request.params);
    const svc = new AutomationService(db());
    return reply.code(201).send({ data: await svc.rollbackToVersion(request.workspaceId, id, version, request.userId) });
  });

  app.get("/automations/:id/versions", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const svc = new AutomationService(db());
    return reply.send({ data: await svc.listVersions(request.workspaceId, id) });
  });

  app.post("/automations/:id/run", manage, async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({ isSimulation: z.boolean().optional(), payload: z.record(z.string(), z.unknown()).optional(), subject: subjectSchema.optional() })
      .parse(request.body ?? {});
    const isSimulation = body.isSimulation ?? false;

    const svc = new AutomationService(db());
    // A simulation runs whatever the canvas currently looks like — the draft — so it works before
    // the first publish, matching the vision doc's "test/simulation before publish" requirement.
    // A real run only ever executes a published version.
    const version = isSimulation
      ? (await svc.getDraftVersion(id)) ?? (await svc.getLatestPublishedVersion(id))
      : await svc.getLatestPublishedVersion(id);
    if (!version) {
      const message = isSimulation
        ? "Automation has no draft or published version to simulate"
        : "Automation has no published version";
      return reply.code(422).send(errorResponse(message, 422));
    }

    if (body.subject) await assertSubjectInWorkspace(db(), request.workspaceId, body.subject);
    const run = await createAutomationRun(db(), {
      automationId: id,
      automationVersionId: version.id,
      workspaceId: request.workspaceId,
      triggerType: "manual",
      triggerRef: request.userId,
      correlationId: randomUUID(),
      graph: version.graph as AutomationGraph,
      idempotencyKey: `manual:${randomUUID()}`,
      isSimulation,
      triggerPayload: body.payload,
      subject: body.subject,
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
      triggerPayload: request.body && typeof request.body === "object" && !Array.isArray(request.body) ? (request.body as Record<string, unknown>) : undefined,
    });
    enqueueAutomationRunAdvance(app.config, { automationRunId: run.id, workspaceId: run.workspaceId }).catch((err: unknown) => {
      app.log.error({ err, runId: run.id }, "Failed to enqueue automation run advance job");
    });
    return reply.code(202).send({ data: { runId: run.id, verified: false } });
  });

  /** COPS-10 run history of one workflow: ?version, ?account_id, ?status, ?before, ?limit. */
  app.get("/automations/:id/runs", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const q = runHistoryQuery.parse(request.query ?? {});
    await new AutomationService(db()).getAutomation(request.workspaceId, id);
    const result = await listRuns(db(), request.workspaceId, {
      automationId: id,
      version: q.version,
      subject: q.account_id ? { type: "account", id: q.account_id } : undefined,
      status: q.status,
      before: q.before ? new Date(q.before) : undefined,
      limit: q.limit,
    });
    return reply.send({ data: result.data, next_before: result.nextBefore });
  });

  /** COPS-10 run history across every workflow, e.g. everything that ran for one account. */
  app.get("/automations/runs", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const q = runHistoryQuery.parse(request.query ?? {});
    const result = await listRuns(db(), request.workspaceId, {
      subject: q.account_id ? { type: "account", id: q.account_id } : undefined,
      status: q.status,
      before: q.before ? new Date(q.before) : undefined,
      limit: q.limit,
    });
    return reply.send({ data: result.data, next_before: result.nextBefore });
  });

  app.get("/automations/runs/:runId", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const { runId } = z.object({ runId: z.string().uuid() }).parse(request.params);
    return reply.send({ data: await getRun(db(), app.config, request.workspaceId, runId) });
  });

  /** Manual recovery for a failed run — see failStep()'s comment for why failures aren't auto-retried. */
  app.post("/automations/runs/:runId/retry", manage, async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const { runId } = z.object({ runId: z.string().uuid() }).parse(request.params);
    const updatedRun = await retryFailedSteps(db(), request.workspaceId, runId);
    enqueueAutomationRunAdvance(app.config, { automationRunId: updatedRun.id, workspaceId: updatedRun.workspaceId }).catch((err: unknown) => {
      app.log.error({ err, runId: updatedRun.id }, "Failed to enqueue automation run advance job after retry");
    });
    return reply.code(202).send({ data: updatedRun });
  });
}
