import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { errorResponse, HttpError } from "../utils/http.js";
import {
  AUTOMATION_MODES,
  classifyAndRecord,
  listDecisions,
  listPolicies,
  upsertActionMode,
} from "../services/policy-gateway.service.js";
import {
  completeWorkflowRun,
  createDecisionFromNba,
  decideView,
  getDecisionView,
  getWorkflowRun,
  listDecisionViews,
  listWorkflowRuns,
  startWorkflowRun,
} from "../services/decision-workflow.service.js";
import {
  approveDexterPlan,
  checkLinkedinVoiceEligibility,
  confirmLinkedinVoiceSent,
  createLinkedinVoiceHandoff,
  draftLinkedinVoiceScript,
  getLinkedinVoiceHandoff,
  invokeDexterPlan,
  listLinkedinVoiceHandoffs,
  proposeDexterPlan,
  recordDexterLearning,
  rejectDexterPlan,
  synthesizeVoiceAudio,
} from "../services/dexter-journey.service.js";
import { getDexterCommandCenter, listDexterPlans } from "../services/dexter-command-center.service.js";
import { getRegionalTamGate, seedDemoWinLossDeals } from "../services/regional-tam-gate.service.js";


/**
 * §1.2 D7/D14/D15 + §10.4/10.5 — Policy Gateway, decisions, workflows, Dexter + LinkedIn voice.
 */
export async function dexterPlatformRoutes(app: FastifyInstance) {
  // ── Policy Gateway ──────────────────────────────────────────────
  app.get("/automation-policy", async (request, reply) => {
    if (!request.workspaceId || !app.db) return reply.code(401).send(errorResponse("Unauthorized", 401));
    return reply.send({ data: await listPolicies(app.db, request.workspaceId) });
  });

  app.put("/automation-policy", async (request, reply) => {
    if (!request.workspaceId || !request.userId || !app.db) {
      return reply.code(401).send(errorResponse("Unauthorized", 401));
    }
    const body = z
      .object({
        actionKey: z.string().min(1).max(120),
        mode: z.enum(AUTOMATION_MODES),
      })
      .safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send(errorResponse("Invalid policy", 400, body.error.flatten()));
    const row = await upsertActionMode(
      app.db,
      request.workspaceId,
      body.data.actionKey,
      body.data.mode,
      request.userId
    );
    return reply.send({ data: row });
  });

  app.post("/policy/classify", async (request, reply) => {
    if (!request.workspaceId || !app.db) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const body = z
      .object({
        actionKey: z.string().min(1).max(120),
        entityType: z.string().optional(),
        entityId: z.string().optional(),
        priorApproval: z.boolean().optional(),
      })
      .safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send(errorResponse("Invalid classify payload", 400, body.error.flatten()));
    const result = await classifyAndRecord(app.db, {
      workspaceId: request.workspaceId,
      actionKey: body.data.actionKey,
      actorUserId: request.userId,
      entityType: body.data.entityType,
      entityId: body.data.entityId,
      priorApproval: body.data.priorApproval,
    });
    return reply.send({ data: result });
  });

  app.get("/policy/decisions", async (request, reply) => {
    if (!request.workspaceId || !app.db) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const rows = await listDecisions(app.db, request.workspaceId);
    return reply.send({ data: rows });
  });

  // ── Decision views (D14) ────────────────────────────────────────
  app.get("/decisions", async (request, reply) => {
    if (!request.workspaceId || !app.db) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const status = typeof (request.query as { status?: string }).status === "string"
      ? (request.query as { status?: string }).status
      : undefined;
    return reply.send({ data: await listDecisionViews(app.db, request.workspaceId, status) });
  });

  app.get("/decisions/:id", async (request, reply) => {
    if (!request.workspaceId || !app.db) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return reply.send({ data: await getDecisionView(app.db, request.workspaceId, id) });
  });

  app.post("/decisions/from-nba", async (request, reply) => {
    if (!request.workspaceId || !app.db) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const body = z
      .object({
        entityType: z.enum(["contact", "deal"]),
        entityId: z.string().uuid(),
      })
      .safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send(errorResponse("Invalid decision payload", 400, body.error.flatten()));
    const row = await createDecisionFromNba(app.db, {
      workspaceId: request.workspaceId,
      entityType: body.data.entityType,
      entityId: body.data.entityId,
      userId: request.userId,
    });
    return reply.code(201).send({ data: row });
  });

  app.post("/decisions/:id/decide", async (request, reply) => {
    if (!request.workspaceId || !app.db) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ choice: z.enum(["decided", "dismissed"]) }).safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send(errorResponse("Invalid choice", 400));
    return reply.send({ data: await decideView(app.db, request.workspaceId, id, body.data.choice) });
  });

  // ── Workflow runs (D15) ─────────────────────────────────────────
  app.get("/workflows/runs", async (request, reply) => {
    if (!request.workspaceId || !app.db) return reply.code(401).send(errorResponse("Unauthorized", 401));
    return reply.send({ data: await listWorkflowRuns(app.db, request.workspaceId) });
  });

  app.post("/workflows/runs", async (request, reply) => {
    if (!request.workspaceId || !app.db) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const body = z
      .object({
        name: z.string().min(1).max(200),
        steps: z.array(z.object({ name: z.string(), status: z.string().optional() })).optional(),
        asyncJobId: z.string().uuid().optional(),
        correlationId: z.string().max(200).optional(),
      })
      .safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send(errorResponse("Invalid workflow run", 400, body.error.flatten()));
    const row = await startWorkflowRun(app.db, {
      workspaceId: request.workspaceId,
      name: body.data.name,
      steps: body.data.steps,
      asyncJobId: body.data.asyncJobId,
      correlationId: body.data.correlationId,
      userId: request.userId,
    });
    return reply.code(201).send({ data: row });
  });

  app.get("/workflows/runs/:id", async (request, reply) => {
    if (!request.workspaceId || !app.db) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return reply.send({ data: await getWorkflowRun(app.db, request.workspaceId, id) });
  });

  app.post("/workflows/runs/:id/complete", async (request, reply) => {
    if (!request.workspaceId || !app.db) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        status: z.enum(["completed", "failed", "cancelled"]),
        errorMessage: z.string().max(2000).optional(),
      })
      .safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send(errorResponse("Invalid complete payload", 400));
    return reply.send({
      data: await completeWorkflowRun(app.db, request.workspaceId, id, body.data.status, body.data.errorMessage),
    });
  });

  // ── Dexter §8.7 command center ────────────────────────────────────
  app.get("/dexter/command-center", async (request, reply) => {
    if (!request.workspaceId || !app.db) return reply.code(401).send(errorResponse("Unauthorized", 401));
    return reply.send({ data: await getDexterCommandCenter(app.db, request.workspaceId) });
  });

  app.get("/dexter/plans", async (request, reply) => {
    if (!request.workspaceId || !app.db) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const status = typeof (request.query as { status?: string }).status === "string"
      ? (request.query as { status?: string }).status
      : undefined;
    return reply.send({ data: await listDexterPlans(app.db, request.workspaceId, status) });
  });

  // ── Dexter §10.4 ────────────────────────────────────────────────
  app.post("/dexter/plans", async (request, reply) => {
    if (!request.workspaceId || !app.db) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const body = z.object({ brief: z.string().min(1).max(4000) }).safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send(errorResponse("Invalid brief", 400));
    const result = await proposeDexterPlan(app.db, app.config, {
      workspaceId: request.workspaceId,
      brief: body.data.brief,
      userId: request.userId,
    });
    return reply.code(201).send({ data: result });
  });

  app.post("/dexter/plans/:id/approve", async (request, reply) => {
    if (!request.workspaceId || !app.db) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return reply.send({ data: await approveDexterPlan(app.db, app.config, request.workspaceId, id) });
  });

  app.post("/dexter/plans/:id/reject", async (request, reply) => {
    if (!request.workspaceId || !app.db) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return reply.send({ data: await rejectDexterPlan(app.db, app.config, request.workspaceId, id) });
  });

  app.post("/dexter/plans/:id/invoke", async (request, reply) => {
    if (!request.workspaceId || !app.db) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return reply.send({
      data: await invokeDexterPlan(app.db, app.config, request.workspaceId, id, request.userId),
    });
  });

  app.post("/dexter/plans/:id/learn", async (request, reply) => {
    if (!request.workspaceId || !app.db) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ learning: z.record(z.unknown()) }).safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send(errorResponse("Invalid learning payload", 400));
    return reply.send({
      data: await recordDexterLearning(app.db, app.config, request.workspaceId, id, body.data.learning),
    });
  });

  // ── LinkedIn voice §10.5 ────────────────────────────────────────
  app.get("/linkedin/voice/eligibility", async (request, reply) => {
    if (!request.workspaceId || !app.db) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const query = z
      .object({
        prospectId: z.string().min(1),
        linkedinUrl: z.string().url().optional(),
      })
      .safeParse(request.query ?? {});
    if (!query.success) return reply.code(400).send(errorResponse("prospectId query parameter required", 400));

    const result = await checkLinkedinVoiceEligibility(app.db, app.config, {
      workspaceId: request.workspaceId,
      prospectId: query.data.prospectId,
      linkedinUrl: query.data.linkedinUrl,
    });
    return reply.send({ data: result });
  });

  app.post("/linkedin/voice/draft-script", async (request, reply) => {
    if (!request.workspaceId || !app.db) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const body = z
      .object({
        prospectId: z.string().min(1).max(200),
        goal: z.string().max(500).optional(),
        tone: z.string().max(200).optional(),
        customNotes: z.string().max(1000).optional(),
        language: z.string().max(32).optional(),
      })
      .safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send(errorResponse("Invalid draft payload", 400, body.error.flatten()));

    const result = await draftLinkedinVoiceScript(app.db, app.config, {
      workspaceId: request.workspaceId,
      prospectId: body.data.prospectId,
      goal: body.data.goal,
      tone: body.data.tone,
      customNotes: body.data.customNotes,
      language: body.data.language,
      userId: request.userId,
    });
    return reply.send({ data: result });
  });

  app.post("/linkedin/voice/synthesize", async (request, reply) => {
    if (!request.workspaceId || !app.db) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const body = z
      .object({
        scriptText: z.string().min(1).max(8000),
        voice: z.enum(["alloy", "echo", "fable", "onyx", "nova", "shimmer"]).optional(),
      })
      .safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send(errorResponse("Invalid synthesis payload", 400, body.error.flatten()));

    const result = await synthesizeVoiceAudio(app.config, {
      scriptText: body.data.scriptText,
      voice: body.data.voice,
    });
    return reply.send({ data: result });
  });

  app.get("/linkedin/voice/handoffs", async (request, reply) => {
    if (!request.workspaceId || !app.db) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const rows = await listLinkedinVoiceHandoffs(app.db, request.workspaceId);
    return reply.send({ data: rows });
  });

  app.get("/linkedin/voice/handoffs/:token", async (request, reply) => {
    if (!request.workspaceId || !app.db) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const { token } = z.object({ token: z.string().uuid() }).parse(request.params);
    try {
      const row = await getLinkedinVoiceHandoff(app.db, app.config, {
        workspaceId: request.workspaceId,
        handoffToken: token,
      });
      return reply.send({ data: row });
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.code(err.statusCode).send(errorResponse(err.message, err.statusCode, err.details));
      }
      throw err;
    }
  });

  app.post("/linkedin/voice/handoff", async (request, reply) => {
    if (!request.workspaceId || !app.db) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const body = z
      .object({
        prospectId: z.string().min(1).max(200),
        scriptText: z.string().min(1).max(8000),
        voiceChoice: z.string().max(50).optional(),
        regionalBriefPreview: z.string().max(4000).optional(),
        language: z.string().max(32).optional(),
        linkedinUrl: z.string().url().optional(),
      })
      .safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send(errorResponse("Invalid handoff", 400, body.error.flatten()));

    try {
      const row = await createLinkedinVoiceHandoff(app.db, app.config, {
        workspaceId: request.workspaceId,
        ...body.data,
        userId: request.userId,
      });
      return reply.code(201).send({ data: row });
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.code(err.statusCode).send(errorResponse(err.message, err.statusCode, err.details));
      }
      throw err;
    }
  });

  app.post("/linkedin/voice/confirm-sent", async (request, reply) => {
    if (!request.workspaceId || !app.db) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const body = z
      .object({
        handoffToken: z.string().uuid(),
        outcomeNote: z.string().max(500).optional(),
      })
      .safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send(errorResponse("Invalid confirm payload", 400));
    try {
      const row = await confirmLinkedinVoiceSent(app.db, {
        workspaceId: request.workspaceId,
        handoffToken: body.data.handoffToken,
        outcomeNote: body.data.outcomeNote,
        userId: request.userId,
      });
      return reply.send({ data: row });
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.code(err.statusCode).send(errorResponse(err.message, err.statusCode, err.details));
      }
      throw err;
    }
  });

  // ── §3 / §11.1 helpers ──────────────────────────────────────────
  app.get("/regional-tam-gate", async (request, reply) => {
    if (!request.workspaceId || !app.db) return reply.code(401).send(errorResponse("Unauthorized", 401));
    return reply.send({ data: await getRegionalTamGate(app.db, request.workspaceId) });
  });

  app.post("/competitive/win-loss/seed-demo", async (request, reply) => {
    if (!request.workspaceId || !request.userId || !app.db) {
      return reply.code(401).send(errorResponse("Unauthorized", 401));
    }
    if (app.config.NODE_ENV === "production") {
      return reply.code(403).send(errorResponse("Demo seed disabled in production", 403));
    }
    const n = await seedDemoWinLossDeals(app.db, request.workspaceId, request.userId);
    return reply.code(201).send({ data: await getRegionalTamGate(app.db, request.workspaceId), seededTo: n });
  });
}
