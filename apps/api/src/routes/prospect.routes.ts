import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { generateCompanyId, generateProspectId, normalizeDomain } from "@skout/shared";
import {
  bulkUpsertProspects,
  type OpenSearchConfig,
  type ProspectDocument,
} from "@skout/opensearch";
import { buildEnrichmentService, InsufficientCreditsError } from "../services/enrichment/index.js";
import type { Env } from "../config/env.js";

function osConfig(env: Env): OpenSearchConfig | null {
  if (!env.OPENSEARCH_URL) return null;
  return {
    url: env.OPENSEARCH_URL,
    username: env.OPENSEARCH_USERNAME,
    password: env.OPENSEARCH_PASSWORD,
    index: env.OPENSEARCH_INDEX,
  };
}


const manualProspectSchema = z.object({
  // Contact — fullName is the only required field
  fullName: z.string().min(1),
  jobTitle: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  linkedinUrl: z.string().url().optional(),
  department: z.string().optional(),
  seniority: z.string().optional(),
  jobFunction: z.string().optional(),
  yearsAtCompany: z.number().min(0).optional(),
  yearsInRole: z.number().min(0).optional(),
  previousCompany: z.string().optional(),
  // Company
  companyName: z.string().optional(),
  companyDomain: z.string().optional(),
  industry: z.string().optional(),
  subIndustry: z.string().optional(),
  companyDescription: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  country: z.string().optional(),
  state: z.string().optional(),
  city: z.string().optional(),
  companySize: z.string().optional(),
  employeeCount: z.number().int().min(1).optional(),
  companyStage: z.string().optional(),
  // Revenue & Funding
  annualRevenue: z.string().optional(),
  revenueRange: z.string().optional(),
  totalFundingRaised: z.string().optional(),
  lastFundingDate: z.string().optional(),
  lastFundingRound: z.string().optional(),
  investors: z.array(z.string()).optional(),
  // Hiring & Tech
  currentlyHiring: z.boolean().optional(),
  openJobCount: z.number().int().min(0).optional(),
  hiringDepartments: z.array(z.string()).optional(),
  crmUsed: z.string().optional(),
  techStackKeywords: z.array(z.string()).optional(),
});

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
  // Manual lead entry — indexes into OpenSearch only (no DB write).
  app.post("/prospects/manual", async (request, reply) => {
    const body = manualProspectSchema.parse(request.body ?? {});

    const domain = normalizeDomain(body.companyDomain ?? "") || "unknown.com";
    const companyId = generateCompanyId(domain);
    const prospectId = body.email
      ? generateProspectId(domain, body.email)
      : generateCompanyId(`${domain}:${body.fullName}`);

    const cfg = osConfig(app.config);
    if (!cfg) {
      return reply.status(503).send({ error: "Search index not configured" });
    }

    const doc: ProspectDocument = {
      prospectId,
      companyId,
      fullName: body.fullName,
      title: body.jobTitle,
      seniority: body.seniority,
      department: body.department,
      jobFunction: body.jobFunction,
      email: body.email,
      phone: body.phone,
      linkedinUrl: body.linkedinUrl,
      companyDomain: domain,
      companyName: body.companyName,
      industry: body.industry,
      subIndustry: body.subIndustry,
      country: body.country,
      state: body.state,
      city: body.city,
      employeeCount: body.employeeCount,
      companyStage: body.companyStage,
      lastFundingRound: body.lastFundingRound,
      currentlyHiring: body.currentlyHiring,
      yearsAtCompany: body.yearsAtCompany,
      yearsInRole: body.yearsInRole,
      previousCompany: body.previousCompany,
      updatedAt: new Date().toISOString(),
    };

    await bulkUpsertProspects(cfg, [doc]);

    return reply.status(201).send({
      prospectId,
      companyId,
      message: "Prospect added to search index",
    });
  });

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
      throw err;
    }
  });
}
