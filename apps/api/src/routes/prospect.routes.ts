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
import { requireWorkspaceId } from "../utils/http.js";

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
  // Contact — fullName + companyDomain required per MVP Path B
  fullName: z.string().min(1),
  companyDomain: z.string().min(1),
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
  listId: z.string().uuid().optional(),
  autoEnrich: z.boolean().optional().default(true),
  enrichFields: z.array(z.enum(["company", "email", "validation", "phone"])).optional(),
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
  // Richer fields captured by the Chrome extension from LinkedIn profiles.
  companyName: z.string().optional(),
  headline: z.string().optional(),
  location: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  about: z.string().optional(),
  connections: z.string().optional(),
  followers: z.string().optional(),
  photoUrl: z.string().url().optional(),
});

const enrichBodySchema = z.object({
  prospect: snapshotSchema,
  fields: z.array(z.enum(["company", "email", "validation", "phone"])).optional(),
});

const activateBodySchema = z.object({
  prospects: z.array(snapshotSchema).min(1),
});

export async function prospectRoutes(app: FastifyInstance) {
  // Manual lead entry — OpenSearch index + workspace activation + optional enrich/list add.
  app.post("/prospects/manual", async (request, reply) => {
    const body = manualProspectSchema.parse(request.body ?? {});
    const workspaceId = requireWorkspaceId(request);

    const domain = normalizeDomain(body.companyDomain);
    const companyId = generateCompanyId(domain);
    const prospectId = body.email
      ? generateProspectId(domain, body.email)
      : generateCompanyId(`${domain}:${body.fullName}`);

    const cfg = osConfig(app.config);
    let indexed = false;

    if (cfg) {
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
      indexed = true;
    }

    const snapshot = {
      prospectId,
      companyId,
      fullName: body.fullName,
      title: body.jobTitle,
      seniority: body.seniority,
      industry: body.industry,
      country: body.country,
      companyDomain: domain,
      companyName: body.companyName,
      email: body.email,
      phone: body.phone,
      linkedinUrl: body.linkedinUrl,
      employeeCount: body.employeeCount,
    };

    const svc = buildEnrichmentService(app.db, app.config);
    await svc.activate(workspaceId, [snapshot]);

    if (body.listId) {
      const added = await svc.addListMembers(workspaceId, body.listId, [snapshot]);
      if (!added) {
        return reply.status(404).send({ error: "list_not_found" });
      }
    }

    let job: Awaited<ReturnType<typeof svc.enrichProspect>> | null = null;
    if (body.autoEnrich) {
      try {
        job = await svc.enrichProspect(workspaceId, snapshot, {
          fields: body.enrichFields ?? ["company", "email", "validation"],
          trigger: "manual",
        });
      } catch (err) {
        if (err instanceof InsufficientCreditsError) {
          return reply.status(402).send({
            error: "insufficient_credits",
            required: err.required,
            available: err.available,
            prospectId,
            companyId,
            activated: true,
          });
        }
        throw err;
      }
    }

    return reply.status(201).send({
      prospectId,
      companyId,
      message: job
        ? "Prospect activated and enrichment started"
        : "Prospect activated",
      activated: true,
      indexed,
      listId: body.listId ?? null,
      ...(job
        ? {
            jobId: job.id,
            jobStatus: job.status,
            creditsUsed: job.creditsUsed,
          }
        : {}),
    });
  });

  app.get("/prospects", async (request, reply) => {
    const workspaceId = requireWorkspaceId(request);
    const svc = buildEnrichmentService(app.db, app.config);
    const data = await svc.listActivations(workspaceId);
    return reply.send({ workspaceId, data, total: data.length });
  });

  // Add corpus prospects to the workspace (activation, no external spend).
  app.post("/prospects/activate", async (request, reply) => {
    const workspaceId = requireWorkspaceId(request);
    const body = activateBodySchema.parse(request.body ?? {});
    const names = body.prospects.map((p) => p.fullName).filter(Boolean);
    request.log.info(
      { workspaceId, count: body.prospects.length, names },
      "prospects/activate"
    );
    const svc = buildEnrichmentService(app.db, app.config);
    const activated = await svc.activate(workspaceId, body.prospects);
    return reply.status(201).send({ activated });
  });

  app.post("/prospects/:id/enrich", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = requireWorkspaceId(request);
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
