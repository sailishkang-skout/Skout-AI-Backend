import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { buildEnrichmentService, InsufficientCreditsError } from "../services/enrichment/index.js";

const snapshotSchema = z.object({
  prospectId: z.string().optional(),
  companyId: z.string().optional(),
  fullName: z.string().optional(),
  title: z.string().optional(),
  seniority: z.string().optional(),
  industry: z.string().optional(),
  country: z.string().optional(),
  companyDomain: z.string().min(1),
  email: z.string().email().optional(),
  linkedinUrl: z.string().url().optional(),
  employeeCount: z.number().optional(),
  signals: z.array(z.string()).optional(),
});

const enrichBodySchema = z.object({
  prospect: snapshotSchema,
  fields: z.array(z.enum(["company", "email", "validation", "phone"])).optional(),
});

const activateBodySchema = z.object({
  prospects: z.array(snapshotSchema).min(1),
});

export async function prospectRoutes(app: FastifyInstance) {
  app.get("/prospects", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildEnrichmentService(app.db, app.config);
    const data = await svc.listActivations(workspaceId);
    return reply.send({ workspaceId, data, total: data.length });
  });

  // Add corpus prospects to the workspace (activation, no external spend).
  app.post("/prospects/activate", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const body = activateBodySchema.parse(request.body ?? {});
    const svc = buildEnrichmentService(app.db, app.config);
    const activated = await svc.activate(workspaceId, body.prospects);
    return reply.status(201).send({ activated });
  });

  app.post("/prospects/:id/enrich", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const body = enrichBodySchema.parse(request.body ?? {});
    const svc = buildEnrichmentService(app.db, app.config);

    try {
      const job = await svc.enrichProspect(
        workspaceId,
        { ...body.prospect, prospectId: body.prospect.prospectId ?? id },
        { fields: body.fields, trigger: "manual" }
      );
      return reply.status(202).send({
        jobId: job.id,
        status: job.status,
        creditsUsed: job.creditsUsed,
        results: job.results,
        attempts: job.attempts,
      });
    } catch (err) {
      if (err instanceof InsufficientCreditsError) {
        return reply.status(402).send({
          error: "insufficient_credits",
          required: err.required,
          available: err.available,
        });
      }
      throw err;
    }
  });
}
