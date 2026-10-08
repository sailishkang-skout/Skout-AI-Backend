import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { searchFiltersSchema } from "@skout/shared";
import { schema } from "@skout/db";
import { buildEnrichmentService, InsufficientCreditsError, SCORE_CREDIT_COST } from "../services/enrichment/index.js";
import { getEnrichmentEfficiency } from "../services/analytics.service.js";
import { getWorkspaceIcp } from "../services/icp.service.js";
import { getAsyncJob } from "../services/async-job.service.js";
import { personalizeProspect } from "../services/personalize.service.js";
import { HttpError, errorResponse, requireWorkspaceId } from "../utils/http.js";
import { buildEntitlementsService } from "../services/entitlements.service.js";
import { recordEvidence } from "../services/evidence.service.js";
import { assertEvidenced } from "@skout/shared";
import { buildModelVersionsService } from "../services/model-versions.service.js";
import { assertPermission, recordPrivilegedAction } from "@skout/auth";
import { getCaptureStatus } from "../services/enrichment/capture-ingest.service.js";
import { exportPeopleRows, PEOPLE_CSV_COLUMNS, toCsv } from "../services/enrichment/research.service.js";
const {
  companies,
  lists,
  sequences,
} = schema;

const jobIdSchema = z.string().uuid();
const exportSchema = z.object({
  type: z.enum(["people", "companies"]).default("people"),
  ids: z.array(z.string().min(1)).max(1000).optional(),
  listId: z.string().uuid().optional(),
});

const scoreBodySchema = z.object({
  prospect: z.object({
    prospectId: z.string().optional(),
    fullName: z.string().optional(),
    title: z.string().optional(),
    seniority: z.string().optional(),
    industry: z.string().optional(),
    country: z.string().optional(),
    companyDomain: z.string().min(1),
    employeeCount: z.number().optional(),
    signals: z.array(z.string()).optional(),
  }),
  icp: z
    .object({
      industries: z.array(z.string()).optional(),
      countries: z.array(z.string()).optional(),
      seniorities: z.array(z.string()).optional(),
      titles: z.array(z.string()).optional(),
      keywords: z.array(z.string()).optional(),
      minEmployees: z.number().optional(),
      maxEmployees: z.number().optional(),
    })
    .optional(),
});

export async function enrichmentRoutes(app: FastifyInstance) {
  app.get("/enrichment/credits", async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:read");
    const svc = buildEnrichmentService(app.db, app.config);
    return reply.send({ workspaceId, balance: await svc.getCredits(workspaceId) });
  });

  /** GTM revamp — Enrichment Efficiency chart: real daily credits-spent vs. valid-emails-found. */
  app.get("/enrichment/efficiency", async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:read");
    const data = await getEnrichmentEfficiency(app.db, workspaceId);
    return reply.send({ workspaceId, data });
  });

  app.get("/enrichment/jobs", async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:read");
    const svc = buildEnrichmentService(app.db, app.config);
    const data = await svc.listJobs(workspaceId);
    return reply.send({ workspaceId, data, total: data.length });
  });

  app.get("/enrichment/jobs/:jobId", async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const { jobId } = request.params as { jobId: string };
    // A client-side-only placeholder id (e.g. the frontend's optimistic-update job entry)
    // isn't a real job and was never going to be found — a clean 404 here, not a raw
    // invalid-uuid DB error, since this route's own contract already documents "not found".
    if (!jobIdSchema.safeParse(jobId).success) return reply.status(404).send({ error: "job_not_found" });
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:read");
    const svc = buildEnrichmentService(app.db, app.config);
    const job = await svc.getJob(workspaceId, jobId);
    if (!job) return reply.status(404).send({ error: "job_not_found" });
    return reply.send(job);
  });

  app.post("/enrichment/jobs/:jobId/retry", { config: { rateLimit: { max: 15, timeWindow: 60000 } } }, async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const { jobId } = request.params as { jobId: string };
    if (!jobIdSchema.safeParse(jobId).success) return reply.status(404).send({ error: "job_not_found" });
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:enrich");
    const svc = buildEnrichmentService(app.db, app.config);
    try {
      const job = await svc.retryJob(workspaceId, jobId);
      
      // Log audit event for re-enrichment (ENR-01 requirement)
      await recordPrivilegedAction(app.db, {
        workspaceId,
        actorId: request.userId,
        action: "enrichment.re-enrich",
        entityType: "prospect",
        entityId: randomUUID(),
        afterState: { prospectId: job.prospectId ?? null, jobId: job.id, status: job.status, retriedAt: new Date().toISOString() }
      });
      
      return reply.status(202).send({
        jobId: job.id,
        status: job.status,
        creditsUsed: job.creditsUsed,
        results: job.results,
        attempts: job.attempts,
        queuedAt: job.queuedAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
      });
    } catch (err) {
      if (err instanceof InsufficientCreditsError) {
        return reply.status(402).send({
          error: "insufficient_credits",
          required: err.required,
          available: err.available,
        });
      }
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send(errorResponse(err.message, err.statusCode));
      }
      throw err;
    }
  });

  app.get("/enrichment/batches/:batchId", async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const { batchId } = request.params as { batchId: string };
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:read");
    const svc = buildEnrichmentService(app.db, app.config);
    const batch = await svc.getBatch(workspaceId, batchId);
    if (!batch) return reply.status(404).send({ error: "batch_not_found" });
    return reply.send(batch);
  });

  app.post("/enrichment/score", { config: { rateLimit: { max: 10, timeWindow: 60000 } } }, async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:enrich");
    const body = scoreBodySchema.parse(request.body ?? {});
    const svc = buildEnrichmentService(app.db, app.config);
    const icp = body.icp ?? (await getWorkspaceIcp(app.db, workspaceId));
    // §5.1 / §16 — additive entitlements override (same pattern as search.credit_cost)
    const entitlementsSvc = app.db ? buildEntitlementsService(app.db) : null;
    const creditCost = entitlementsSvc
      ? await entitlementsSvc.getValueOr<number>(workspaceId, "enrichment.score_credit_cost", SCORE_CREDIT_COST)
      : SCORE_CREDIT_COST;
    try {
      const result = await svc.score(workspaceId, { ...body.prospect }, icp, creditCost);
      
      // Log enrichment capture audit event
      await recordPrivilegedAction(app.db, {
        workspaceId,
        actorId: request.userId,
        action: "enrichment.score",
        entityType: "prospect",
        entityId: randomUUID(),
        afterState: { prospectId: body.prospect.prospectId ?? null, companyDomain: body.prospect.companyDomain }
      });

      // §6.1 — pin score claim to evidence_ledger before returning (fail-closed when prospectId known)
      let evidenceId: string | undefined;
      if (app.db && body.prospect.prospectId) {
        const versions = buildModelVersionsService(app.db);
        const activeModel = versions ? await versions.getActiveModelVersion("score") : null;
        const row = await recordEvidence(app.db, {
          workspaceId,
          entityType: "prospect",
          entityId: body.prospect.prospectId,
          attribute: "icpScore",
          value: {
            icpScore: result.icpScore,
            outreachReadiness: result.outreachReadiness,
            reasoning: result.reasoning,
          },
          source: "ai_score",
          observedAt: new Date(),
          confidence:
            typeof result.icpScore === "number" ? Math.min(1, Math.max(0, result.icpScore / 100)) : 0.5,
          method: "enrichment_score",
          resolutionRuleOrModelVersion: activeModel?.id,
          freshnessExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        });
        evidenceId = row?.id;
        assertEvidenced({ value: result, evidenceId }, "enrichment score");
        return reply.send({ ...result, evidenceId });
      }

      // Ephemeral score without a persisted prospect — explicit unverified (not an AI claim stored as fact)
      assertEvidenced({ value: result, unverified: true }, "enrichment score (ephemeral)");
      return reply.send({ ...result, evidenceId: null });
    } catch (err) {
      if (err instanceof InsufficientCreditsError) {
        return reply.status(402).send({
          error: "insufficient_credits",
          required: err.required,
          available: err.available,
        });
      }
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send(errorResponse(err.message, err.statusCode));
      }
      throw err;
    }
  });

  app.post("/enrichment/scores/lookup", async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:read");
    const body = z.object({ prospectIds: z.array(z.string()).min(1).max(100) }).parse(request.body ?? {});
    const svc = buildEnrichmentService(app.db, app.config);
    const scores = await svc.lookupScores(workspaceId, body.prospectIds);
    return reply.send({ scores });
  });

  app.get("/enrichment/score-jobs/:jobId", async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const { jobId } = request.params as { jobId: string };
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:read");
    try {
      const job = await getAsyncJob(app.db, workspaceId, jobId);
      return reply.send(job);
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send(errorResponse(err.message, err.statusCode));
      }
      // Properly handle all error types with type safety
      if (err instanceof Error) {
        throw err;
      }
      // Convert unknown error types to proper Error instances
      throw new Error(`Unexpected error: ${String(err)}`);
    }
  });

  app.post("/enrichment/personalize", { config: { rateLimit: { max: 15, timeWindow: 60000 } } }, async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:enrich");
    const body = z
      .object({
        prospectId: z.string(),
        fullName: z.string().optional(),
        title: z.string().optional(),
        companyDomain: z.string().optional(),
        painPoints: z.array(z.string()).optional(),
        icpScore: z.number().optional(),
        companyCountry: z.string().optional(),
      })
      .parse(request.body ?? {});

    try {
      const result = await personalizeProspect(app.db, app.config, workspaceId, body);
      await recordPrivilegedAction(app.db, {
        workspaceId,
        actorId: request.userId,
        action: "enrichment.personalize",
        entityType: "prospect",
        entityId: randomUUID(),
        afterState: { prospectId: body.prospectId, fullName: body.fullName, title: body.title, companyDomain: body.companyDomain }
      });
      return reply.send(result);
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send(errorResponse(err.message, err.statusCode));
      }
      throw err;
    }
  });

  // ENR-01: Frontend-aligned enrichment routes to support dashboard integration
  // These routes map the LinkedIn EnrichmentTool's expected endpoints to Skout's existing backend functionality

  // People, companies, job changes, evidence and delete live in enrichment-research.routes.ts (ENR-03).

  // GET /enrichment/campaigns - Get all campaigns (maps to lists)
  app.get("/enrichment/campaigns", async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:read");
    
    const campaigns = await app.db
      .select({
        id: sequences.id,
        name: sequences.name,
        status: sequences.status,
        createdAt: sequences.createdAt,
        updatedAt: sequences.updatedAt,
      })
      .from(sequences)
      .where(eq(sequences.workspaceId, workspaceId))
      .orderBy(desc(sequences.updatedAt));
    return reply.send({
      workspaceId,
      campaigns,
      total: campaigns.length,
      source: "sequences",
    });
  });

  // GET /enrichment/capture - Get capture interface data (credits)
  app.get("/enrichment/capture", async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:capture");
    
    const service = buildEnrichmentService(app.db, app.config);
    return reply.send({
      workspaceId,
      balance: await service.getCredits(workspaceId),
      captureEndpoint: "/api/v1/enrichment/ingest",
      capture: await getCaptureStatus(app.db, { workspaceId, userId: request.userId }),
    });
  });

  // POST /enrichment/export - Export enriched data (maps to list export)
  app.post("/enrichment/export", { config: { rateLimit: { max: 10, timeWindow: 60000 } } }, async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:export");
    const body = exportSchema.parse(request.body ?? {});
    const service = buildEnrichmentService(app.db, app.config);

    let rows: Array<Record<string, unknown>>;
    let columns: string[];
    if (body.type === "people") {
      let ids = body.ids;
      if (body.listId) {
        const [list] = await app.db
          .select({ id: lists.id })
          .from(lists)
          .where(and(eq(lists.id, body.listId), eq(lists.workspaceId, workspaceId)))
          .limit(1);
        if (!list) return reply.status(404).send({ error: "list_not_found" });
        ids = await service.getListMemberIds(workspaceId, body.listId);
      }
      const people = await exportPeopleRows(app.db, workspaceId, {});
      rows = people
        .filter((person) => !ids || ids.includes(person.prospectId))
        .map((person) => ({ id: person.prospectId, ...person }));
      columns = ["id", ...PEOPLE_CSV_COLUMNS.filter((column) => column !== "prospectId")];
    } else {
      const companyRows = await app.db
        .select()
        .from(companies)
        .where(and(eq(companies.workspaceId, workspaceId), isNull(companies.deletedAt)));
      rows = companyRows
        .filter((company) => !body.ids || body.ids.includes(company.id))
        .map((company) => ({ ...company }));
      columns = ["id", "name", "domain", "industry", "employeeCount", "location", "status"];
    }

    await recordPrivilegedAction(app.db, {
      workspaceId,
      actorId: request.userId,
      action: "enrichment.export",
      entityType: body.type,
      entityId: randomUUID(),
      afterState: { exportedAt: new Date().toISOString(), recordCount: rows.length },
    });
    reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="skout-${body.type}.csv"`);
    return reply.send(toCsv(rows, columns));
  });

  // GET /enrichment/people/:id/export.csv - Export single person data
  app.get("/enrichment/people/:id/export.csv", { config: { rateLimit: { max: 10, timeWindow: 60000 } } }, async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const { id } = request.params as { id: string };
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:export");
    const service = buildEnrichmentService(app.db, app.config);
    const person = await service.getActivation(workspaceId, id);
    if (!person) return reply.status(404).send({ error: "person_not_found" });
    await recordPrivilegedAction(app.db, {
      workspaceId,
      actorId: request.userId,
      action: "enrichment.export",
      entityType: "person",
      entityId: randomUUID(),
      afterState: { prospectId: id, exportedAt: new Date().toISOString(), recordCount: 1 }
    });
    reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="person-${encodeURIComponent(id)}.csv"`);
    const [row] = (await exportPeopleRows(app.db, workspaceId, {})).filter((entry) => entry.prospectId === id);
    return reply.send(
      toCsv(
        [{ id: person.prospectId, ...(row ?? person.snapshot) }],
        ["id", ...PEOPLE_CSV_COLUMNS.filter((column) => column !== "prospectId")]
      )
    );
  });
}