import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { generateCompanyId, generateProspectId, normalizeDomain } from "@skout/shared";
import {
  bulkUpsertProspects,
  type OpenSearchConfig,
  type ProspectDocument,
} from "@skout/opensearch";
import { buildEnrichmentService, InsufficientCreditsError } from "../services/enrichment/index.js";
import type { Env } from "../config/env.js";
import { HttpError, requireWorkspaceId } from "../utils/http.js";
import { emitSkoutEvent } from "../services/skout-event.service.js";
import { createLogger } from "@skout/observability";
import { assertPermission, recordPrivilegedAction } from "@skout/auth";
import { ensureContactLinkedToProspect } from "../services/prospect-crm-link.service.js";
import { assertCaptureEnabled, CaptureError } from "../services/enrichment/capture-ingest.service.js";
import { auditEntityId } from "../utils/audit-entity-id.js";

const log = createLogger("prospect.routes");
const { companyPersonDiscoveries, enrichmentSnapshots, enrichmentChangeEvents } = schema;

const captureArraySchema = z.array(z.unknown()).max(100);

function osConfig(env: Env): OpenSearchConfig | null {
  if (!env.OPENSEARCH_URL) return null;
  return {
    url: env.OPENSEARCH_URL,
    username: env.OPENSEARCH_USERNAME,
    password: env.OPENSEARCH_PASSWORD,
    index: env.OPENSEARCH_INDEX,
  };
}

async function recordCaptureHistory(
  db: Db,
  workspaceId: string,
  actorId: string,
  entityId: string,
  rawData: Record<string, unknown>,
  crmLink: { contactId: string | null; companyId: string | null },
  capturedVia: "EXTENSION" | "ENRICHMENT_API" | "MANUAL_IMPORT",
  discoverySource: string
): Promise<void> {
  await db.transaction(async (tx) => {
    const recordSnapshot = async (
      entityType: "person" | "company",
      snapshotEntityId: string,
      snapshotData: Record<string, unknown>
    ) => {
      const capturedData = Object.fromEntries(
        Object.entries(snapshotData).filter(([, value]) => value !== undefined)
      );
      const fieldHashes = Object.fromEntries(
        Object.entries(capturedData).map(([field, value]) => [
          field,
          createHash("sha256").update(JSON.stringify(value)).digest("hex"),
        ])
      );
      const [previous] = await tx
        .select()
        .from(enrichmentSnapshots)
        .where(
          and(
            eq(enrichmentSnapshots.workspaceId, workspaceId),
            eq(enrichmentSnapshots.entityType, entityType),
            eq(enrichmentSnapshots.entityId, snapshotEntityId)
          )
        )
        .orderBy(desc(enrichmentSnapshots.capturedAt))
        .limit(1);

      await tx.insert(enrichmentSnapshots).values({
        workspaceId,
        entityType,
        entityId: snapshotEntityId,
        fieldHashes,
        rawData: capturedData,
        capturedVia,
        capturedBy: actorId,
      });

      if (!previous) return;
      const oldHashes = previous.fieldHashes as Record<string, string>;
      const oldData = previous.rawData as Record<string, unknown>;
      const changes = Object.entries(capturedData)
        .filter(([field]) => oldHashes[field] !== fieldHashes[field])
        .map(([field, newValue]) => ({
          workspaceId,
          entityType,
          entityId: snapshotEntityId,
          field,
          changeType: Object.hasOwn(oldHashes, field) ? ("FIELD_UPDATED" as const) : ("FIELD_ADDED" as const),
          oldValue: oldData[field] ?? null,
          newValue,
          isJobChange: entityType === "person" && ["title", "headline", "currentCompanies", "companyName"].includes(field),
        }));
      if (changes.length) await tx.insert(enrichmentChangeEvents).values(changes);
    };

    await recordSnapshot("person", entityId, rawData);
    if (crmLink.companyId && crmLink.contactId) {
      await tx.insert(companyPersonDiscoveries).values({
        workspaceId,
        companyId: crmLink.companyId,
        contactId: crmLink.contactId,
        source: discoverySource,
      }).onConflictDoNothing();

      await recordSnapshot("company", crmLink.companyId, {
        name: rawData.companyName ?? rawData.companyDomain,
        domain: rawData.companyDomain,
        industry: rawData.industry,
        employeeCount: rawData.employeeCount,
      });
    }

    await recordPrivilegedAction(tx, {
      workspaceId,
      actorId,
      action: "enrichment.capture",
      entityType: crmLink.contactId ? "contact" : "person",
      entityId: crmLink.contactId ?? randomUUID(),
      afterState: {
        prospectId: entityId,
        contactId: crmLink.contactId,
        companyId: crmLink.companyId,
        source: discoverySource,
      },
    });
  });
}

async function recordProspectCapture(
  db: Db,
  workspaceId: string,
  actorId: string,
  prospectId: string,
  rawData: Record<string, unknown>,
  capturedVia: "EXTENSION" | "ENRICHMENT_API" | "MANUAL_IMPORT",
  discoverySource: string
): Promise<void> {
  const companyDomain = typeof rawData.companyDomain === "string"
    ? normalizeDomain(rawData.companyDomain)
    : null;
  const companyName = typeof rawData.companyName === "string" && rawData.companyName.trim()
    ? rawData.companyName.trim()
    : companyDomain;
  const fullName = typeof rawData.fullName === "string"
    ? rawData.fullName
    : [rawData.firstName, rawData.lastName].filter((value): value is string => typeof value === "string").join(" ");
  const crmLink = await ensureContactLinkedToProspect(db, workspaceId, prospectId, {
    email: typeof rawData.email === "string" ? rawData.email : null,
    fullName: fullName || null,
    companyDomain,
    companyName,
    title: typeof rawData.title === "string" ? rawData.title : null,
    linkedinUrl: typeof rawData.linkedinUrl === "string" ? rawData.linkedinUrl : null,
  });
  await recordCaptureHistory(db, workspaceId, actorId, prospectId, rawData, crmLink, capturedVia, discoverySource);
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
  publicId: z.string().max(300).optional(),
  urn: z.string().max(500).optional(),
  firstName: z.string().max(300).optional(),
  lastName: z.string().max(300).optional(),
  summary: z.string().max(20_000).optional(),
  locationCountry: z.string().max(300).optional(),
  relationshipContext: z.record(z.unknown()).optional(),
  currentCompanies: captureArraySchema.optional(),
  previousCompanies: captureArraySchema.optional(),
  educations: captureArraySchema.optional(),
  volunteerExperiences: captureArraySchema.optional(),
  skills: captureArraySchema.optional(),
  pronoun: z.string().max(100).optional(),
  related: captureArraySchema.optional(),
  languages: captureArraySchema.optional(),
  recommendations: captureArraySchema.optional(),
  certifications: captureArraySchema.optional(),
  courses: captureArraySchema.optional(),
  honors: captureArraySchema.optional(),
  organizations: captureArraySchema.optional(),
  patents: captureArraySchema.optional(),
  projects: captureArraySchema.optional(),
  publications: captureArraySchema.optional(),
  jobFunction: z.string().max(300).optional(),
  openToWork: z.boolean().optional(),
  hiring: z.boolean().optional(),
  lastUpdated: z.string().datetime().optional(),
});

const enrichBodySchema = z.object({
  prospect: snapshotSchema,
  fields: z.array(z.enum(["company", "email", "validation", "phone"])).optional(),
});

const activateBodySchema = z.object({
  prospects: z.array(snapshotSchema).min(1).max(250),
});

export async function prospectRoutes(app: FastifyInstance) {
  // Manual lead entry — OpenSearch index + workspace activation + optional enrich/list add.
  app.post("/prospects/manual", { config: { rateLimit: { max: 20, timeWindow: 60000 } } }, async (request, reply) => {
    const body = manualProspectSchema.parse(request.body ?? {});
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db!, workspaceId, request.userId, "enrichment:enrich");

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
    await recordProspectCapture(
      app.db!,
      workspaceId,
      request.userId,
      prospectId,
      snapshot,
      "MANUAL_IMPORT",
      "manual_prospect_capture"
    );

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
        if (job.status === "completed") {
          await emitSkoutEvent(app.db, app.config, {
            type: "enrichment.completed",
            tenantId: workspaceId,
            aggregateId: prospectId,
            data: { workspaceId, prospectId, companyId, jobId: job.id, status: job.status, creditsUsed: job.creditsUsed, trigger: "activate_auto_enrich" },
          }).catch((err: unknown) => log.warn("failed to emit enrichment.completed", { prospectId, err }));
        }
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
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db!, workspaceId, request.userId, "enrichment:read");
    const svc = buildEnrichmentService(app.db, app.config);
    const data = await svc.listActivations(workspaceId);
    return reply.send({ workspaceId, data, total: data.length });
  });

  // Add corpus prospects to the workspace (activation, no external spend).
  app.post("/prospects/activate", { config: { rateLimit: { max: 15, timeWindow: 60000 } } }, async (request, reply) => {
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db!, workspaceId, request.userId, "enrichment:capture");
    const body = activateBodySchema.parse(request.body ?? {});
    request.log.info({ workspaceId, count: body.prospects.length }, "prospects/activate");
    // ENR-02 — the workspace capture kill switch also covers the extension's add-to-list path.
    if (body.prospects.some((prospect) => prospect.linkedinUrl)) {
      try {
        await assertCaptureEnabled(app.db!, workspaceId);
      } catch (error) {
        if (error instanceof CaptureError) {
          return reply.status(error.statusCode).send({ ok: false, error: error.message, code: error.code });
        }
        throw error;
      }
    }
    const svc = buildEnrichmentService(app.db, app.config);
    const activated = await svc.activate(workspaceId, body.prospects);
    for (const prospect of body.prospects) {
      const companyId = prospect.companyId ?? generateCompanyId(prospect.companyDomain);
      const prospectId =
        prospect.prospectId ??
        (prospect.email
          ? generateProspectId(prospect.companyDomain, prospect.email)
          : generateCompanyId(`${prospect.companyDomain}:${prospect.fullName ?? ""}`));
      const companyDomain = normalizeDomain(prospect.companyDomain);
      await recordProspectCapture(app.db!, workspaceId, request.userId, prospectId, {
        ...prospect,
        prospectId,
        companyId,
        companyDomain,
      }, "EXTENSION", "linkedin_profile_capture");
    }
    return reply.status(201).send({ activated });
  });

  app.post("/prospects/:id/enrich", { config: { rateLimit: { max: 15, timeWindow: 60000 } } }, async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const { id } = request.params as { id: string };
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:enrich");
    const body = enrichBodySchema.parse(request.body ?? {});
    const svc = buildEnrichmentService(app.db, app.config);

    try {
      const job = await svc.enrichProspect(
        workspaceId,
        { ...body.prospect, prospectId: body.prospect.prospectId ?? id },
        { fields: body.fields, trigger: "manual" }
      );
      if (job.status === "completed") {
        await emitSkoutEvent(app.db, app.config, {
          type: "enrichment.completed",
          tenantId: workspaceId,
          aggregateId: body.prospect.prospectId ?? id,
          data: { workspaceId, prospectId: body.prospect.prospectId ?? id, jobId: job.id, status: job.status, creditsUsed: job.creditsUsed, trigger: "manual_enrich" },
        }).catch((err: unknown) => log.warn("failed to emit enrichment.completed", { prospectId: id, err }));
      }
      
      // Log audit event for initial enrichment (ENR-01 requirement)
      await recordPrivilegedAction(app.db, {
        workspaceId,
        actorId: request.userId,
        action: "enrichment.enrich",
        entityType: "prospect",
        // Prospect ids are text; audit_logs.entity_id is uuid (see auditEntityId). The real id is in after_state.
        entityId: auditEntityId(body.prospect.prospectId ?? id),
        afterState: { prospectId: body.prospect.prospectId ?? id, jobId: job.id },
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
      throw err;
    }
  });
}