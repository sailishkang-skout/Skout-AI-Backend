import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { buildEnrichmentService } from "../services/enrichment/index.js";
import { getWorkspaceIcp } from "../services/icp.service.js";

const scoreBodySchema = z.object({
  prospect: z.object({
    prospectId: z.string().optional(),
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
    const result = await svc.score(workspaceId, { ...body.prospect }, icp);
    return reply.send(result);
  });

  app.post("/enrichment/personalize", async (request, reply) => {
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
    const aiUrl = app.config.AI_SERVICE_URL;
    if (!aiUrl) {
      return reply.send({
        prospectId: body.prospectId,
        opener: `Hi ${body.fullName ?? "there"} — reaching out about ${body.companyDomain}.`,
        talkingPoints: body.painPoints ?? [],
        source: "heuristic",
      });
    }
    const res = await fetch(`${aiUrl}/v1/personalize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
    return reply.send(await res.json());
  });
}
