import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, inArray } from "drizzle-orm";
import { searchFiltersSchema } from "@skout/shared";
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
import { schema } from "@skout/db";
const { prospectActivations, companies, listMembers, asyncJobs, skoutEvents, evidenceLedger } = schema;

const jobIdSchema = z.string().uuid();

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
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:capture");
    const svc = buildEnrichmentService(app.db, app.config);
    return reply.send({ workspaceId, balance: await svc.getCredits(workspaceId) });
  });

  /** GTM revamp — Enrichment Efficiency chart: real daily credits-spent vs. valid-emails-found. */
  app.get("/enrichment/efficiency", async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:capture");
    const data = await getEnrichmentEfficiency(app.db, workspaceId);
    return reply.send({ workspaceId, data });
  });

  app.get("/enrichment/jobs", async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:capture");
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
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:capture");
    const svc = buildEnrichmentService(app.db, app.config);
    const job = await svc.getJob(workspaceId, jobId);
    if (!job) return reply.status(404).send({ error: "job_not_found" });
    return reply.send(job);
  });

  app.post("/enrichment/jobs/:jobId/retry", async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const { jobId } = request.params as { jobId: string };
    if (!jobIdSchema.safeParse(jobId).success) return reply.status(404).send({ error: "job_not_found" });
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:capture");
    const svc = buildEnrichmentService(app.db, app.config);
    try {
      const job = await svc.retryJob(workspaceId, jobId);
      
      // Log audit event for re-enrichment (ENR-01 requirement)
      await recordPrivilegedAction(app.db, {
        workspaceId,
        actorId: request.userId,
        action: "enrichment.re-enrich",
        entityType: "prospect",
        entityId: job.prospectId ?? jobId,
        afterState: { jobId: job.id, status: job.status, retriedAt: new Date().toISOString() }
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
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:capture");
    const svc = buildEnrichmentService(app.db, app.config);
    const batch = await svc.getBatch(workspaceId, batchId);
    if (!batch) return reply.status(404).send({ error: "batch_not_found" });
    return reply.send(batch);
  });

  app.post("/enrichment/score", { config: { rateLimit: { max: 10, timeWindow: 60000 } } }, async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:capture");
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
        action: "enrichment.capture",
        entityType: "prospect",
        entityId: body.prospect.prospectId ?? "anonymous",
        afterState: { companyDomain: body.prospect.companyDomain, fullName: body.prospect.fullName, title: body.prospect.title }
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
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:capture");
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
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:capture");
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
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
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:capture");
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
        entityId: body.prospectId,
        afterState: { fullName: body.fullName, title: body.title, companyDomain: body.companyDomain }
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

  // GET /enrichment/people - List all people/prospects for the workspace
  app.get("/enrichment/people", async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:read");
    
    const svc = buildEnrichmentService(app.db, app.config);
    const data = await svc.listActivations(workspaceId);
    return reply.send({ workspaceId, people: data, total: data.length });
  });

  // GET /enrichment/people/:id - Get a single person/prospect by ID
  app.get("/enrichment/people/:id", async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const { id } = request.params as { id: string };
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:read");
    
    // Forward to existing search/prospects/:id endpoint
    const searchSvc = await import("./search.routes.js");
    // Reuse the existing prospect fetch logic
    const svc = buildEnrichmentService(app.db, app.config);
    const person = await svc.getActivation(workspaceId, id);
    if (!person) return reply.status(404).send({ error: "person_not_found" });
    return reply.send({ workspaceId, person });
  });

  // DELETE /enrichment/people/:id - Delete a person/prospect
  app.delete("/enrichment/people/:id", async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const { id } = request.params as { id: string };
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:write");
    
    // First verify the prospect belongs to this workspace
    const prospectExists = await app.db.query.prospectActivations.findFirst({
      where: (prospect, { eq, and }) => and(eq(prospect.prospectId, id), eq(prospect.workspaceId, workspaceId))
    });
    
    if (!prospectExists) {
      return reply.status(404).send({ error: "prospect_not_found", message: "The requested person does not exist in your workspace" });
    }
    
    // Log audit event for deletion (ENR-01 requirement)
    await recordPrivilegedAction(app.db, {
      workspaceId,
      actorId: request.userId,
      action: "enrichment.delete",
      entityType: "person",
      entityId: id,
      afterState: { deleted: true }
    });
    
    // Production-grade deletion - remove all related data
    await app.db.transaction(async (tx) => {
      // 1. Delete all evidence records for this prospect
      await tx.delete(evidenceLedger).where(and(eq(evidenceLedger.entityType, "prospect"), eq(evidenceLedger.entityId, id)));
      // 2. Delete all change events
      await tx.delete(skoutEvents).where(eq(skoutEvents.aggregateId, id));
      // 3. Delete async jobs
      await tx.delete(asyncJobs).where(eq(asyncJobs.entityId, id));
      // 4. Remove from all lists
      await tx.delete(listMembers).where(eq(listMembers.prospectId, id));
      // 5. Finally delete the prospect itself
      await tx.delete(prospectActivations).where(and(eq(prospectActivations.prospectId, id), eq(prospectActivations.workspaceId, workspaceId)));
    });
    
    return reply.send({ success: true, workspaceId, deletedId: id });
  });

// GET /enrichment/people/:id/evidence - Get all evidence for a person
app.get("/enrichment/people/:id/evidence", async (request, reply) => {
  if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
  const { id } = request.params as { id: string };
  const workspaceId = requireWorkspaceId(request);
  if (!request.userId) throw new HttpError("unauthorized", 401);
  await assertPermission(app.db, workspaceId, request.userId, "enrichment:read");
  
  // Fetch all evidence records for this prospect from the database
  const evidence = await app.db.query.evidenceLedger.findMany({
    where: (evidence, { eq, and }) => and(eq(evidence.entityType, "prospect"), eq(evidence.entityId, id), eq(evidence.workspaceId, workspaceId))
  });
  
  return reply.send({ workspaceId, evidence });
});

// GET /enrichment/companies/:id/evidence - Get all evidence for a company
app.get("/enrichment/companies/:id/evidence", async (request, reply) => {
  if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
  const { id } = request.params as { id: string };
  const workspaceId = requireWorkspaceId(request);
  if (!request.userId) throw new HttpError("unauthorized", 401);
  await assertPermission(app.db, workspaceId, request.userId, "enrichment:read");
  
  // Fetch all evidence records for this company from the database
  const evidence = await app.db.query.evidenceLedger.findMany({
    where: (evidence, { eq, and }) => and(eq(evidence.entityType, "company"), eq(evidence.entityId, id), eq(evidence.workspaceId, workspaceId))
  });
  
  return reply.send({ workspaceId, evidence });
});

  // GET /enrichment/companies - List all companies for the workspace
  app.get("/enrichment/companies", async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:read");
    
    const svc = buildEnrichmentService(app.db, app.config);
    const data = await svc.listActivations(workspaceId);
    // Filter and format company data
    const companies = data.filter(item => item.companyId).map(item => ({
      ...item,
      _count: { employees: 0 }
    }));
    return reply.send({ workspaceId, companies, total: companies.length });
  });



  // GET /enrichment/companies/:id - Get a single company by ID
  app.get("/enrichment/companies/:id", async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const { id } = request.params as { id: string };
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:read");
    
    // Forward to existing account-360/:id endpoint pattern
    return reply.redirect(`/account-360/${id}`);
  });

  // DELETE /enrichment/companies/:id - Delete a company
  app.delete("/enrichment/companies/:id", async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const { id } = request.params as { id: string };
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:write");
    
    // First verify the company belongs to this workspace
    const companyExists = await app.db.query.companies.findFirst({
      where: (companies, { eq, and }) => and(eq(companies.id, id), eq(companies.workspaceId, workspaceId))
    });
    
    if (!companyExists) {
      return reply.status(404).send({ error: "company_not_found", message: "The requested company does not exist in your workspace" });
    }
    
    // Log audit event for deletion (ENR-01 requirement)
    await recordPrivilegedAction(app.db, {
      workspaceId,
      actorId: request.userId,
      action: "enrichment.delete",
      entityType: "company",
      entityId: id,
      afterState: { deleted: true }
    });
    
    // Production-grade deletion - remove all related data
    await app.db.transaction(async (tx) => {
      // 1. First get all prospectIds associated with this company
      const companyProspects = await tx
        .select({ prospectId: prospectActivations.prospectId })
        .from(prospectActivations)
        .where(and(eq(prospectActivations.companyId, id), eq(prospectActivations.workspaceId, workspaceId)));
      const prospectIds = companyProspects.map(p => p.prospectId);
      
      // 2. Delete all company evidence records
      await tx.delete(evidenceLedger).where(and(eq(evidenceLedger.entityType, "company"), eq(evidenceLedger.entityId, id)));
      // 3. Delete all change events for this company
      await tx.delete(skoutEvents).where(eq(skoutEvents.aggregateId, id));
      // 4. Delete async jobs
      await tx.delete(asyncJobs).where(eq(asyncJobs.entityId, id));
      // 5. Remove company's prospects from all lists (if any)
      if (prospectIds.length > 0) {
        await tx.delete(listMembers).where(inArray(listMembers.prospectId, prospectIds));
      }
      // 6. Remove company association from all prospects
      await tx.update(prospectActivations).set({ companyId: null as any }).where(and(eq(prospectActivations.companyId, id), eq(prospectActivations.workspaceId, workspaceId)));
      // 7. Finally delete the company itself
      await tx.delete(companies).where(and(eq(companies.id, id), eq(companies.workspaceId, workspaceId)));
    });
    
    return reply.send({ success: true, workspaceId, deletedId: id });
  });

  // GET /enrichment/job-changes - Get job change events
  app.get("/enrichment/job-changes", async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:read");
    
    const svc = buildEnrichmentService(app.db, app.config);
    const jobs = await svc.listJobs(workspaceId);
    // Map jobs to job change events format
    const jobChanges = jobs.map(job => ({
      id: job.id,
      field: "status",
      changeType: "update",
      oldValue: null,
      newValue: job.status,
      isJobChange: false,
      detectedAt: job.queuedAt,
      person: null
    }));
    return reply.send({ workspaceId, jobChanges, total: jobChanges.length });
  });

  // GET /enrichment/campaigns - Get all campaigns (maps to lists)
  app.get("/enrichment/campaigns", async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:read");
    
    // Forward to existing lists endpoint
    return reply.redirect("/lists");
  });

  // GET /enrichment/capture - Get capture interface data (credits)
  app.get("/enrichment/capture", async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:capture");
    
    // Forward to existing credits endpoint
    return reply.redirect("/enrichment/credits");
  });

  // POST /enrichment/export - Export enriched data (maps to list export)
  app.post("/enrichment/export", async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:write");
    
    // Log audit event for export (ENR-01 requirement)
    await recordPrivilegedAction(app.db, {
      workspaceId,
      actorId: request.userId,
      action: "enrichment.export",
      entityType: "dataset",
      entityId: "export",
      afterState: { exportedAt: new Date().toISOString() }
    });
    
    const body = request.body as { type?: string; id?: string };
    // Forward to list export if listId is provided, otherwise return export info
    if (body?.id) {
      return reply.redirect(`/lists/${body.id}/export/csv`);
    }
    return reply.send({ exportedAt: new Date().toISOString(), workspaceId, recordCount: 0, data: [] });
  });

  // GET /enrichment/people/:id/export.csv - Export single person data
  app.get("/enrichment/people/:id/export.csv", async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const { id } = request.params as { id: string };
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:write");
    
    // Log audit event for single record export
    await recordPrivilegedAction(app.db, {
      workspaceId,
      actorId: request.userId,
      action: "enrichment.export",
      entityType: "person",
      entityId: id,
      afterState: { exportedAt: new Date().toISOString() }
    });
    
    // Return a simple CSV for now - in production this would contain the actual person data
    reply.header("Content-Type", "text/csv");
    reply.header("Content-Disposition", `attachment; filename="person-${id}.csv"`);
    return reply.send("id,fullName,email,company\n" + `${id},Sample Person,sample@example.com,Sample Company`);
  });
}