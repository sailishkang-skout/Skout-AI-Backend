import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { guardWithReleaseGate } from "../services/enrichment/release-gate.js";
import { suggestForJobChanges } from "../services/enrichment/campaign.service.js";
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

import {
  cancelCaptureJob,
  captureJobDetails,
  captureQueueIdSchema,
  captureQueueListSchema,
  captureQueueSyncSchema,
  captureQueueUpdateSchema,
  listCapturableCompanies,
  listCaptureQueue,
  recordCaptureQueueBatch,
  removeFromCaptureQueue,
  requestCaptureResume,
  syncCaptureQueue,
} from "../services/enrichment/capture-queue.service.js";
import {
  autoCaptureAvailability,
  autoCaptureStartSchema,
  pauseAutoCapture,
  startAutoCapture,
} from "../services/enrichment/capture-auto.service.js";
import { companyIdForPublicId, listRequestedJobScans, recordJobScan, startJobScan } from "../services/enrichment/company-jobs.service.js";
import { jobScanSchema } from "../services/enrichment/capture-schemas.js";
import { indexCapturedPeople } from "../services/enrichment/capture-search-index.js";
import { openSearchConfigFromEnv } from "../lib/opensearch-config.js";

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
  guardWithReleaseGate(app);
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
      // ENR-05 — a detected job change becomes a review item (a draft for a person to look at).
      // It is never submitted or sent from here, and a failure never fails the capture.
      await suggestForJobChanges(db, app.config, actor.workspaceId).catch((error: unknown) =>
        request.log.warn({ err: error }, "job-change suggestion failed")
      );
      // Make the person findable in Search & Discover. A failure never fails the capture.
      const searchIndex = openSearchConfigFromEnv(app.config);
      if (searchIndex && person) {
        const { prospectId } = person as { prospectId: string };
        await indexCapturedPeople(db, searchIndex, actor.workspaceId, [prospectId]).catch((error: unknown) =>
          request.log.warn({ err: error }, "indexing captured person for search failed")
        );
      }
      return reply.status(201).send({ run: runDto(run), person, ...counts });
    } catch (error) {
      return sendCaptureError(reply, error);
    }
  });

  app.post("/enrichment/ingest/company", ingestRoute, async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:capture");
    const body = companyIngestSchema.parse(request.body ?? {});
    try {
      const { run, company, jobScan, ...counts } = await ingestCompanyCapture(db, actor, body);
      return reply.status(201).send({ run: runDto(run), company, jobScan: jobScan?.scan ?? null, ...counts });
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

  // Adds every profile captured before indexing existed, from ALL workspaces, to Search &
  // Discover. Captures are shared across workspaces, so this is one global run, not per workspace.
  app.post("/enrichment/search-index/backfill", async (request, reply) => {
    const { db } = await authorize(request, "enrichment:admin");
    const searchIndex = openSearchConfigFromEnv(app.config);
    if (!searchIndex) return reply.status(503).send({ error: "search_index_unavailable" });
    return reply.send(await indexCapturedPeople(db, searchIndex, null));
  });

  // Companies captured in this workspace, for the extension's company queue.
  app.get("/enrichment/capture/companies", async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:capture");
    const { q } = z.object({ q: z.string().trim().max(100).optional() }).parse(request.query ?? {});
    return reply.send({ companies: await listCapturableCompanies(db, actor.workspaceId, q) });
  });

  // Capture jobs: ongoing, completed and failed, for the dashboard's Capture queue page.
  app.get("/enrichment/capture/queue", async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:read");
    const filters = captureQueueListSchema.parse(request.query ?? {});
    return reply.send(await listCaptureQueue(db, actor.workspaceId, filters));
  });

  app.get("/enrichment/capture/queue/:publicId", async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:read");
    const publicId = captureQueueIdSchema.parse((request.params as { publicId: string }).publicId);
    const details = await captureJobDetails(db, actor.workspaceId, publicId);
    if (!details) return reply.status(404).send({ error: "not_found", message: "That capture job does not exist." });
    return reply.send(details);
  });

  app.post("/enrichment/capture/queue/:publicId/cancel", async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:capture");
    const publicId = captureQueueIdSchema.parse((request.params as { publicId: string }).publicId);
    const item = await cancelCaptureJob(db, actor, publicId);
    if (!item) return reply.status(409).send({ error: "job_not_cancellable", message: "That job has finished, was cancelled already, or does not exist." });
    return reply.send({ item });
  });

  // The extension reports its whole run queue after every change.
  app.post(
    "/enrichment/capture/queue/sync",
    { config: { rateLimit: { max: 120, timeWindow: 60000 } } },
    async (request, reply) => {
      const { db, actor } = await authorize(request, "enrichment:capture");
      return reply.send(await syncCaptureQueue(db, actor, captureQueueSyncSchema.parse(request.body ?? {})));
    }
  );

  // Resume or retry: the job is queued again and the extension offers to start it.
  app.post("/enrichment/capture/queue/:publicId/resume", async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:capture");
    const publicId = captureQueueIdSchema.parse((request.params as { publicId: string }).publicId);
    const item = await requestCaptureResume(db, actor, publicId);
    if (!item) return reply.status(409).send({ error: "job_not_resumable", message: "That job is running now or no longer exists." });
    return reply.send({ item });
  });

  app.put(
    "/enrichment/capture/queue/:publicId",
    { config: { rateLimit: { max: 60, timeWindow: 60000 } } },
    async (request, reply) => {
      const { db, actor } = await authorize(request, "enrichment:capture");
      const publicId = captureQueueIdSchema.parse((request.params as { publicId: string }).publicId);
      const body = captureQueueUpdateSchema.parse(request.body ?? {});
      return reply.send({ item: await recordCaptureQueueBatch(db, actor, publicId, body) });
    }
  );

  // Automatic (server-side) people capture through the workspace's Unipile LinkedIn account.
  app.get("/enrichment/capture/auto", async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:read");
    const availability = await autoCaptureAvailability(db, app.config, actor.workspaceId);
    return reply.send({ available: availability.available, reason: availability.reason, accountName: availability.account?.displayName ?? null });
  });

  app.post("/enrichment/capture/auto", { config: { rateLimit: { max: 20, timeWindow: 60000 } } }, async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:capture");
    const { companyPublicIds } = autoCaptureStartSchema.parse(request.body ?? {});
    const result = await startAutoCapture(db, app.config, actor, companyPublicIds);
    if (!result.ok) return reply.status(409).send({ error: "auto_capture_unavailable", message: result.reason });
    return reply.send({ queued: result.queued, skipped: result.skipped });
  });

  app.post("/enrichment/capture/queue/:publicId/pause", async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:capture");
    const publicId = captureQueueIdSchema.parse((request.params as { publicId: string }).publicId);
    const item = await pauseAutoCapture(db, actor, publicId);
    if (!item) {
      return reply.status(409).send({ error: "job_not_pausable", message: "Only a queued or running automatic job can be paused here; pause an extension job from the extension." });
    }
    return reply.send({ item });
  });

  app.delete("/enrichment/capture/queue/:publicId", async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:capture");
    const publicId = captureQueueIdSchema.parse((request.params as { publicId: string }).publicId);
    if (!(await removeFromCaptureQueue(db, actor.workspaceId, publicId))) return reply.status(404).send({ error: "not_found" });
    return reply.status(204).send();
  });

  // Latest Job Roles from the extension: one scan of a company's job listings (initial and
  // verification pass). Sending the same scan again records it once.
  app.post("/enrichment/companies/:publicId/jobs/scan", ingestRoute, async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:capture");
    const { publicId } = request.params as { publicId: string };
    const scan = jobScanSchema.parse(request.body ?? {});
    const companyId = await companyIdForPublicId(db, actor.workspaceId, captureQueueIdSchema.parse(publicId));
    if (!companyId) {
      return reply.status(409).send({ error: "company_not_captured", message: "Capture this company first, then its job roles can be saved." });
    }
    const result = await recordJobScan(db, actor, companyId, scan);
    return reply.status(result.replay ? 200 : 201).send(result);
  });

  app.post("/enrichment/companies/:publicId/jobs/scan/start", async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:capture");
    const { publicId } = request.params as { publicId: string };
    const { clientScanId } = z.object({ clientScanId: z.string().trim().min(8).max(100) }).strict().parse(request.body ?? {});
    const companyId = await companyIdForPublicId(db, actor.workspaceId, captureQueueIdSchema.parse(publicId));
    if (!companyId) return reply.status(409).send({ error: "company_not_captured", message: "Capture this company first, then its job roles can be saved." });
    return reply.send(await startJobScan(db, actor, companyId, clientScanId));
  });

  // Job scans asked for in the workspace, for the extension's side panel.
  app.get("/enrichment/capture/job-scans/requested", async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:capture");
    return reply.send({ scans: await listRequestedJobScans(db, actor.workspaceId) });
  });

  app.get("/enrichment/ingest/company/:publicId/captured-profile-ids", async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:capture");
    const { publicId } = request.params as { publicId: string };
    return reply.send({ publicIds: await capturedCompanyProfileIds(db, actor.workspaceId, publicId) });
  });
}
