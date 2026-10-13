import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { guardWithReleaseGate } from "../services/enrichment/release-gate.js";
import { z } from "zod";
import type { Db } from "@skout/db";
import { assertPermission, recordPrivilegedAction } from "@skout/auth";
import { HttpError, requireWorkspaceId } from "../utils/http.js";
import { CaptureError, type CaptureActor } from "../services/enrichment/capture-ingest.service.js";
import { getContactData, verifyContactEmail } from "../services/enrichment/contact-data.service.js";
import {
  checkProviderConnection,
  connectUnipileAccount,
  disconnectProviderConnection,
  listProviderConnections,
} from "../services/enrichment/provider-connections.service.js";
import {
  createProviderJob,
  getAttemptRawResponse,
  getProviderJob,
  isTestMode,
  listProviderJobs,
} from "../services/enrichment/provider-jobs.service.js";
import { listProviderPolicies } from "../services/enrichment/provider-policy.js";
import { enrichmentOpsSnapshot, evaluateAlerts } from "../services/enrichment/ops.service.js";
import { enqueueEnrichmentProviderJob } from "../workers/enrichment-provider-job.queue.js";

const uuid = z.string().uuid();
const createJobBody = z.object({ url: z.string().trim().url().max(2_000) }).strict();
const jobsQuery = z.object({
  status: z.enum(["queued", "running", "partial", "action_required", "failed", "done"]).optional(),
  targetId: z.string().trim().min(1).max(200).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
const connectBody = z.object({ externalAccountId: z.string().trim().min(1).max(500) }).strict();
const idempotencyKey = z.string().trim().min(8).max(200);

type Permission = "enrichment:read" | "enrichment:enrich" | "enrichment:admin";

/**
 * ENR-04 — provider enrichment jobs, provider connections and contact data.
 *
 * Jobs are created here and run by the worker; a response never claims more than the job row
 * records. Provider connections are managed by workspace administrators and carry an account
 * id and a credential reference — no endpoint here accepts, stores or returns a secret.
 */
export async function enrichmentProviderRoutes(app: FastifyInstance) {
  guardWithReleaseGate(app);
  async function authorize(request: FastifyRequest, permission: Permission): Promise<{ db: Db; actor: CaptureActor }> {
    if (!app.db) throw new HttpError("database_unavailable", 503);
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, permission);
    return { db: app.db, actor: { workspaceId, userId: request.userId } };
  }

  function sendError(reply: FastifyReply, error: unknown) {
    if (error instanceof CaptureError) {
      return reply.status(error.statusCode).send({ ok: false, error: error.message, code: error.code });
    }
    throw error;
  }

  const mutation = { config: { rateLimit: { max: 20, timeWindow: 60000 } } };

  // ── Jobs ────────────────────────────────────────────────────────────────────

  // Add a LinkedIn profile or company URL and queue a provider job for it. Also the re-enrich action.
  app.post("/enrichment/provider-jobs", mutation, async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:enrich");
    const body = createJobBody.parse(request.body ?? {});
    const header = request.headers["idempotency-key"];
    const key = header === undefined ? undefined : idempotencyKey.parse(Array.isArray(header) ? header[0] : header);
    try {
      const created = await createProviderJob(db, actor, { url: body.url, idempotencyKey: key });
      // 202: accepted and queued. If the queue cannot be reached the job stays queued in the
      // database and the worker's recovery pass picks it up.
      if (!created.reused) await enqueueEnrichmentProviderJob(app.config, created.job.id);
      return reply.status(202).send({ workspaceId: actor.workspaceId, ...created, testMode: isTestMode(app.config) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/enrichment/provider-jobs", async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:read");
    const filters = jobsQuery.parse(request.query ?? {});
    return reply.send({ workspaceId: actor.workspaceId, ...(await listProviderJobs(db, actor.workspaceId, filters)) });
  });

  app.get("/enrichment/provider-jobs/:jobId", async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:read");
    const { jobId } = request.params as { jobId: string };
    const found = uuid.safeParse(jobId).success ? await getProviderJob(db, actor.workspaceId, jobId) : null;
    if (!found) return reply.status(404).send({ error: "job_not_found" });
    return reply.send({ workspaceId: actor.workspaceId, ...found });
  });

  // The raw provider response kept as evidence for one attempt. Administrators only; each read is audited.
  app.get("/enrichment/provider-jobs/:jobId/attempts/:attemptId/raw", mutation, async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:admin");
    const { jobId, attemptId } = request.params as { jobId: string; attemptId: string };
    const raw =
      uuid.safeParse(jobId).success && uuid.safeParse(attemptId).success
        ? await getAttemptRawResponse(db, actor.workspaceId, jobId, attemptId)
        : null;
    if (!raw) return reply.status(404).send({ error: "raw_response_not_found" });
    await recordPrivilegedAction(db, {
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      action: "enrichment.provider_response.read",
      entityType: "enrichment_attempt",
      entityId: attemptId,
      afterState: { jobId, provider: raw.provider },
    });
    return reply.send({ workspaceId: actor.workspaceId, jobId, attemptId, ...raw });
  });

  // ── Providers ───────────────────────────────────────────────────────────────

  app.get("/enrichment/providers", async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:read");
    return reply.send({
      workspaceId: actor.workspaceId,
      testMode: isTestMode(app.config),
      providers: listProviderPolicies(app.config),
      connections: await listProviderConnections(db, actor.workspaceId),
    });
  });

  app.post("/enrichment/provider-connections/unipile", mutation, async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:admin");
    const body = connectBody.parse(request.body ?? {});
    try {
      const connection = await connectUnipileAccount(db, app.config, actor, body);
      return reply.status(201).send({ workspaceId: actor.workspaceId, connection });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/enrichment/provider-connections/:id/check", mutation, async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:admin");
    const { id } = request.params as { id: string };
    const connection = uuid.safeParse(id).success ? await checkProviderConnection(db, app.config, actor, id) : null;
    if (!connection) return reply.status(404).send({ error: "provider_connection_not_found" });
    return reply.send({ workspaceId: actor.workspaceId, connection });
  });

  app.delete("/enrichment/provider-connections/:id", mutation, async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:admin");
    const { id } = request.params as { id: string };
    const connection = uuid.safeParse(id).success ? await disconnectProviderConnection(db, actor, id) : null;
    if (!connection) return reply.status(404).send({ error: "provider_connection_not_found" });
    return reply.send({ workspaceId: actor.workspaceId, connection });
  });

  // ── Operations ──────────────────────────────────────────────────────────────

  // Capture-run, job, provider-error and queue-lag numbers for this workspace, with the alerts
  // they trip and what to do about each.
  app.get("/enrichment/ops", async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:admin");
    const snapshot = await enrichmentOpsSnapshot(db, actor.workspaceId);
    return reply.send({ workspaceId: actor.workspaceId, snapshot, alerts: evaluateAlerts(snapshot) });
  });

  // ── Contact data ────────────────────────────────────────────────────────────

  app.get("/enrichment/people/:id/contact-data", async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:read");
    const { id } = request.params as { id: string };
    const contactData = await getContactData(db, actor.workspaceId, id);
    if (!contactData) return reply.status(404).send({ error: "person_not_found" });
    return reply.send({ workspaceId: actor.workspaceId, contactData });
  });

  app.post("/enrichment/people/:id/contact-data/verify-email", mutation, async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:enrich");
    const { id } = request.params as { id: string };
    try {
      const contactData = await verifyContactEmail(db, app.config, actor, id);
      if (!contactData) return reply.status(404).send({ error: "person_not_found" });
      return reply.send({ workspaceId: actor.workspaceId, contactData });
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
