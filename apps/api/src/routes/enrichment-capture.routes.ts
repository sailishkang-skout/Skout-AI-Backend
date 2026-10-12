import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "@skout/db";
import { assertPermission } from "@skout/auth";
import { HttpError, requireWorkspaceId } from "../utils/http.js";
import {
  CAPTURE_BODY_LIMIT_BYTES,
  captureSettingsSchema,
  companyIngestSchema,
  finishRunSchema,
  personIngestSchema,
  salesSearchIngestSchema,
  startRunSchema,
} from "../services/enrichment/capture-schemas.js";
import {
  CaptureError,
  capturedCompanyProfileIds,
  finishCaptureRun,
  getCaptureRun,
  getCaptureStatus,
  ingestCompanyCapture,
  ingestPersonCapture,
  ingestSalesSearchCapture,
  listCaptureRuns,
  startCaptureRun,
  updateCaptureSettings,
  type CaptureActor,
  type CaptureRun,
} from "../services/enrichment/capture-ingest.service.js";

const uuidSchema = z.string().uuid();

function runDto(run: CaptureRun) {
  return {
    id: run.id,
    kind: run.kind,
    status: run.status,
    terminal: run.status !== "running",
    userId: run.userId,
    sourceUrl: run.sourceUrl,
    pagesRead: run.pagesRead,
    leadsReceived: run.leadsReceived,
    leadsCreated: run.leadsCreated,
    leadsMerged: run.leadsMerged,
    leadsRejected: run.leadsRejected,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}

/**
 * ENR-02 — capture pipeline: authenticated, workspace-scoped ingest for the extension's
 * reviewed captures, with capture-run records, per-run caps, per-user daily limits and a
 * workspace kill switch.
 */
export async function enrichmentCaptureRoutes(app: FastifyInstance) {
  async function authorize(
    request: FastifyRequest,
    permission: "enrichment:capture" | "enrichment:read" | "enrichment:admin"
  ): Promise<{ db: Db; actor: CaptureActor }> {
    if (!app.db) throw new HttpError("database_unavailable", 503);
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, permission);
    return { db: app.db, actor: { workspaceId, userId: request.userId } };
  }

  /** Capture failures always name a stable code and, when one exists, the run's recorded state. */
  function sendCaptureError(reply: FastifyReply, error: unknown) {
    if (error instanceof CaptureError) {
      return reply.status(error.statusCode).send({
        ok: false,
        error: error.message,
        code: error.code,
        run: error.run ? runDto(error.run) : null,
      });
    }
    throw error;
  }

  const ingestRoute = {
    bodyLimit: CAPTURE_BODY_LIMIT_BYTES,
    config: { rateLimit: { max: 30, timeWindow: 60000 } },
  };

  app.get("/enrichment/capture/status", async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:capture");
    return reply.send({ workspaceId: actor.workspaceId, ...(await getCaptureStatus(db, actor)) });
  });

  // Workspace kill switch and daily limit.
  app.put("/enrichment/capture/settings", { config: { rateLimit: { max: 20, timeWindow: 60000 } } }, async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:admin");
    const body = captureSettingsSchema.parse(request.body ?? {});
    return reply.send({ workspaceId: actor.workspaceId, ...(await updateCaptureSettings(db, actor, body)) });
  });

  app.get("/enrichment/capture/runs", async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:read");
    const runs = await listCaptureRuns(db, actor.workspaceId);
    return reply.send({ workspaceId: actor.workspaceId, runs: runs.map(runDto), total: runs.length });
  });

  app.get("/enrichment/capture/runs/:runId", async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:read");
    const { runId } = request.params as { runId: string };
    const run = uuidSchema.safeParse(runId).success ? await getCaptureRun(db, actor.workspaceId, runId) : null;
    if (!run) return reply.status(404).send({ error: "run_not_found" });
    return reply.send({ workspaceId: actor.workspaceId, run: runDto(run) });
  });

  app.post("/enrichment/capture/runs", { config: { rateLimit: { max: 30, timeWindow: 60000 } } }, async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:capture");
    const body = startRunSchema.parse(request.body ?? {});
    try {
      const run = await startCaptureRun(db, actor, body);
      return reply.status(201).send({ run: runDto(run), ...(await getCaptureStatus(db, actor)) });
    } catch (error) {
      return sendCaptureError(reply, error);
    }
  });

  app.post("/enrichment/capture/runs/:runId/finish", { config: { rateLimit: { max: 30, timeWindow: 60000 } } }, async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:capture");
    const { runId } = request.params as { runId: string };
    if (!uuidSchema.safeParse(runId).success) return reply.status(404).send({ error: "run_not_found" });
    const body = finishRunSchema.parse(request.body ?? {});
    try {
      return reply.send({ run: runDto(await finishCaptureRun(db, actor, runId, body)) });
    } catch (error) {
      return sendCaptureError(reply, error);
    }
  });

  app.post("/enrichment/ingest/person", ingestRoute, async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:capture");
    const body = personIngestSchema.parse(request.body ?? {});
    try {
      const { run, person, ...counts } = await ingestPersonCapture(db, actor, body);
      return reply.status(201).send({ run: runDto(run), person, ...counts });
    } catch (error) {
      return sendCaptureError(reply, error);
    }
  });

  app.post("/enrichment/ingest/company", ingestRoute, async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:capture");
    const body = companyIngestSchema.parse(request.body ?? {});
    try {
      const { run, company, ...counts } = await ingestCompanyCapture(db, actor, body);
      return reply.status(201).send({ run: runDto(run), company, ...counts });
    } catch (error) {
      return sendCaptureError(reply, error);
    }
  });

  // Sales Navigator filters are chosen by the signed-in user; this stores only the people
  // cards that were visibly rendered in that search.
  app.post("/enrichment/ingest/sales-search", ingestRoute, async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:capture");
    const body = salesSearchIngestSchema.parse(request.body ?? {});
    try {
      const { run, ...counts } = await ingestSalesSearchCapture(db, actor, body);
      return reply.status(201).send({ run: runDto(run), ...counts });
    } catch (error) {
      return sendCaptureError(reply, error);
    }
  });

  app.get("/enrichment/ingest/company/:publicId/captured-profile-ids", async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:capture");
    const { publicId } = request.params as { publicId: string };
    return reply.send({ publicIds: await capturedCompanyProfileIds(db, actor.workspaceId, publicId) });
  });
}
