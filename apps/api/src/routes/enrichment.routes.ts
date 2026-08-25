import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { schema } from "@skout/db";
import { searchFiltersSchema } from "@skout/shared";
import { buildEnrichmentService, InsufficientCreditsError, SCORE_CREDIT_COST } from "../services/enrichment/index.js";
import { getWorkspaceIcp } from "../services/icp.service.js";
import { getAsyncJob } from "../services/async-job.service.js";
import { HttpError, errorResponse } from "../utils/http.js";
import { injectTraceContext } from "@skout/observability";
import { buildEntitlementsService } from "../services/entitlements.service.js";
import { recordEvidence } from "../services/evidence.service.js";
import { assertEvidenced } from "@skout/shared";
import { buildModelVersionsService } from "../services/model-versions.service.js";
import { pinAiClaim } from "../services/ai-evidence.service.js";

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
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildEnrichmentService(app.db, app.config);
    return reply.send({ workspaceId, balance: await svc.getCredits(workspaceId) });
  });

  app.get("/enrichment/jobs", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildEnrichmentService(app.db, app.config);
    const data = await svc.listJobs(workspaceId);
    return reply.send({ workspaceId, data, total: data.length });
  });

  app.get("/enrichment/jobs/:jobId", async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildEnrichmentService(app.db, app.config);
    const job = await svc.getJob(workspaceId, jobId);
    if (!job) return reply.status(404).send({ error: "job_not_found" });
    return reply.send(job);
  });

  app.post("/enrichment/jobs/:jobId/retry", async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildEnrichmentService(app.db, app.config);
    try {
      const job = await svc.retryJob(workspaceId, jobId);
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
    const { batchId } = request.params as { batchId: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildEnrichmentService(app.db, app.config);
    const batch = await svc.getBatch(workspaceId, batchId);
    if (!batch) return reply.status(404).send({ error: "batch_not_found" });
    return reply.send(batch);
  });

  app.post("/enrichment/score", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
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
    const workspaceId = request.workspaceId ?? "unknown";
    const body = z.object({ prospectIds: z.array(z.string()).min(1).max(100) }).parse(request.body ?? {});
    const svc = buildEnrichmentService(app.db, app.config);
    const scores = await svc.lookupScores(workspaceId, body.prospectIds);
    return reply.send({ scores });
  });

  app.get("/enrichment/score-jobs/:jobId", async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const workspaceId = request.workspaceId ?? "unknown";
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    try {
      const job = await getAsyncJob(app.db, workspaceId, jobId);
      return reply.send(job);
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send(errorResponse(err.message, err.statusCode));
      }
      throw err;
    }
  });

  app.post("/enrichment/personalize", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const body = z
      .object({
        prospectId: z.string(),
        fullName: z.string().optional(),
        title: z.string().optional(),
        companyDomain: z.string().optional(),
        painPoints: z.array(z.string()).optional(),
        icpScore: z.number().optional(),
      })
      .parse(request.body ?? {});

    type PersonalizeResult = {
      prospectId: string;
      opener: string;
      talkingPoints: string[];
      source: string;
    };

    let result: PersonalizeResult;
    const aiUrl = app.config.AI_SERVICE_URL;
    if (!aiUrl) {
      result = {
        prospectId: body.prospectId,
        opener: `Hi ${body.fullName ?? "there"} — reaching out about ${body.companyDomain}.`,
        talkingPoints: body.painPoints ?? [],
        source: "heuristic",
      };
    } else {
      const res = await fetch(`${aiUrl}/v1/personalize`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...injectTraceContext() },
        body: JSON.stringify({
          prospect_id: body.prospectId,
          full_name: body.fullName,
          title: body.title,
          company_domain: body.companyDomain,
          pain_points: body.painPoints ?? [],
          icp_score: body.icpScore,
        }),
        signal: AbortSignal.timeout(app.config.ENRICHMENT_AI_TIMEOUT_MS),
      });
      if (!res.ok) return reply.status(502).send({ error: "ai_service_error" });
      const ai = (await res.json()) as Partial<PersonalizeResult>;
      result = {
        prospectId: body.prospectId,
        opener: ai.opener ?? `Hi ${body.fullName ?? "there"}`,
        talkingPoints: ai.talkingPoints ?? body.painPoints ?? [],
        source: ai.source ?? "ai",
      };
    }

    const draftBody = [result.opener, ...result.talkingPoints].filter(Boolean).join("\n\n");
    const subject = `Outreach to ${body.fullName ?? body.companyDomain ?? "prospect"}`;

    let draftId: string | undefined;
    if (app.db && workspaceId !== "unknown") {
      const [draft] = await app.db
        .insert(schema.aiDrafts)
        .values({
          workspaceId,
          prospectId: body.prospectId,
          subject,
          body: draftBody,
          model: result.source,
        })
        .returning({ id: schema.aiDrafts.id });
      draftId = draft?.id;

      const pinned = await pinAiClaim(app.db, {
        workspaceId,
        entityType: "prospect",
        entityId: body.prospectId,
        attribute: "personalize",
        value: {
          opener: result.opener,
          talkingPoints: result.talkingPoints,
          draftId,
        },
        source: "ai_personalize",
        method: "enrichment_personalize",
        versionName: "personalize",
      });
      return reply.send({
        ...result,
        draftId,
        subject,
        body: draftBody,
        evidenceId: pinned.evidenceId,
        modelVersionId: pinned.modelVersionId,
        promptVersionId: pinned.promptVersionId,
      });
    }

    return reply.send({ ...result, draftId, subject, body: draftBody, evidenceId: null });
  });
}
