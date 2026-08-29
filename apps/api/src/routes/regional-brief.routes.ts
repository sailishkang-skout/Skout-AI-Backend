import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createRegionalBriefService,
  isPlatformAdmin,
  REGIONAL_BRIEF_LAYER_TYPES,
  REGIONAL_BRIEF_FIELD_CATEGORIES,
} from "../services/regional-brief.service.js";
import { createCountryIndustryTamService } from "../services/country-industry-tam.service.js";
import { HttpError } from "../utils/http.js";

const GLOBAL_LAYERS = new Set(["global", "region", "country", "industry"]);

const createSlotSchema = z.object({
  layerType: z.enum(REGIONAL_BRIEF_LAYER_TYPES),
  /** Accepts alpha-2, alpha-3, or canonical country name. */
  countryIso: z.string().min(2).max(64).optional(),
  regionCode: z.string().optional(),
  /** Free-text phrase or NAICS code — normalized internally by the service. */
  industry: z.string().optional(),
  workspaceId: z.string().uuid().optional(),
  fieldCategory: z.enum(REGIONAL_BRIEF_FIELD_CATEGORIES),
});

const createVersionSchema = z.object({
  content: z.object({ summary: z.string().min(1), details: z.array(z.string()) }),
  source: z.string().min(1),
  effectiveDate: z.string().datetime(),
  confidence: z.number().int().min(0).max(100),
  evidence: z.string().min(1),
  expiryDate: z.string().datetime().optional(),
});

const rejectSchema = z.object({ reason: z.string().min(1) });

export async function regionalBriefRoutes(app: FastifyInstance) {
  if (!app.db) {
    app.log.warn("Database not available — regional-brief routes disabled");
    return;
  }
  const svc = createRegionalBriefService(app.db, app.config);
  const tamSvc = createCountryIndustryTamService(app.db);

  function requirePlatformAdmin(request: { userEmail?: string }) {
    if (!isPlatformAdmin(app.config, request.userEmail)) {
      throw new HttpError("Requires platform-admin access", 403);
    }
  }

  // ── Admin check ────────────────────────────────────────────────────────────

  app.get("/regional-brief/admin-check", async (request, reply) => {
    return reply.send({ platformAdmin: isPlatformAdmin(app.config, request.userEmail) });
  });

  // ── Country list (for UI picker) ───────────────────────────────────────────

  /**
   * GET /regional-brief/countries
   * Returns all countries with iso codes and region IDs.
   */
  app.get("/regional-brief/countries", async (_request, reply) => {
    const data = await svc.listCountries();
    return reply.send({ data, total: data.length });
  });

  // ── Resolve brief ──────────────────────────────────────────────────────────

  /**
   * GET /regional-brief/resolve?country=US|USA|"United States"&industry=saas|51
   *
   * Accepts alpha-2, alpha-3 or canonical country name.
   * Accepts NAICS code or a phrase synonym (e.g. "saas" → "51").
   * Returns ResolvedBrief with countryIso3, industryName, and entries per field_category.
   */
  app.get("/regional-brief/resolve", async (request, reply) => {
    const query = z
      .object({
        country: z.string().min(2),
        industry: z.string().optional(),
      })
      .parse(request.query);

    const resolved = await svc.resolveRegionalBrief({
      countryIso: query.country,
      industry: query.industry,
      workspaceId: request.workspaceId,
    });
    return reply.send(resolved);
  });

  // ── TAM endpoint ───────────────────────────────────────────────────────────

  /**
   * GET /regional-brief/tam?country=US&industry=51&icpPct=0.08&acvUsd=30000
   *
   * Returns TAM figures for a country × NAICS industry pair.
   * When establishments are not yet loaded, returns isDataLoaded=false and null TAM values
   * (null ≠ zero market — per the Excel Read Me policy).
   * icpPct and acvUsd are optional per-call overrides; stored ICP/ACV defaults are used otherwise.
   */
  app.get("/regional-brief/tam", async (request, reply) => {
    const query = z
      .object({
        country: z.string().min(2),
        industry: z.string().min(1),
        icpPct: z.coerce.number().min(0).max(1).optional(),
        acvUsd: z.coerce.number().positive().optional(),
      })
      .parse(request.query);

    const result = await tamSvc.getTam({
      countryIso: query.country,
      naicsCode: query.industry,
      icpPctOverride: query.icpPct,
      acvUsdOverride: query.acvUsd,
    });
    return reply.send(result);
  });

  /**
   * GET /regional-brief/tam/rows?country=US
   * List raw TAM rows for a country (admin / internal use).
   */
  app.get("/regional-brief/tam/rows", async (request, reply) => {
    requirePlatformAdmin(request);
    const query = z.object({ country: z.string().min(2).optional() }).parse(request.query);
    const rows = await tamSvc.listTamRows(query.country);
    return reply.send({ data: rows, total: rows.length });
  });

  /**
   * POST /regional-brief/tam/rows
   * Upsert a TAM row (platform admin only).
   * Supports setting establishments, ICP/ACV overrides, data source + year.
   */
  app.post("/regional-brief/tam/rows", async (request, reply) => {
    requirePlatformAdmin(request);
    const body = z
      .object({
        countryIso: z.string().min(2),
        industryCode: z.string().min(1),
        industryName: z.string().min(1),
        establishments: z.number().int().positive().optional().nullable(),
        icpFitPct: z.number().min(0).max(1).optional(),
        icpFitOverride: z.number().min(0).max(1).optional().nullable(),
        acvUsd: z.number().positive().optional(),
        acvOverrideUsd: z.number().positive().optional().nullable(),
        dataSource: z.string().optional().nullable(),
        dataYear: z.number().int().optional().nullable(),
        canonicalInclude: z.boolean().optional(),
      })
      .parse(request.body);

    const row = await tamSvc.upsertTamRow(body);
    return reply.code(201).send(row);
  });

  // ── Slots ──────────────────────────────────────────────────────────────────

  app.post("/regional-brief/slots", async (request, reply) => {
    const body = createSlotSchema.parse(request.body);
    if (GLOBAL_LAYERS.has(body.layerType)) {
      requirePlatformAdmin(request);
    }
    const slot = await svc.findOrCreateSlot({
      ...body,
      workspaceId:
        body.workspaceId ??
        (body.layerType === "tenant" || body.layerType === "outcome_learning"
          ? request.workspaceId
          : undefined),
    });
    return reply.code(201).send(slot);
  });

  app.post("/regional-brief/slots/:id/versions", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = createVersionSchema.parse(request.body);

    const slots = await svc.listSlots({});
    const slot = slots.find((s) => s.id === id);
    if (!slot) return reply.code(404).send({ error: "regional_brief_slot_not_found" });
    if (GLOBAL_LAYERS.has(slot.layerType)) {
      requirePlatformAdmin(request);
    }

    const version = await svc.createDraftVersion(id, {
      content: body.content,
      source: body.source,
      effectiveDate: new Date(body.effectiveDate),
      confidence: body.confidence,
      evidence: body.evidence,
      expiryDate: body.expiryDate ? new Date(body.expiryDate) : null,
      createdBy: request.userId!,
    });
    return reply.code(201).send(version);
  });

  app.get("/regional-brief/slots", async (request, reply) => {
    const query = z.object({ layerType: z.string().optional(), status: z.string().optional() }).parse(request.query);
    const slots = await svc.listSlots(query);
    return reply.send({ data: slots, total: slots.length });
  });

  app.get("/regional-brief/slots/:id/versions", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const versions = await svc.listVersions(id);
    return reply.send({ data: versions, total: versions.length });
  });

  // ── Version approval / rejection ──────────────────────────────────────────

  app.post("/regional-brief/versions/:id/approve", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const versions = await svc.listVersions(undefined, id);
    const version = versions[0];
    if (!version) return reply.code(404).send({ error: "regional_brief_version_not_found" });
    const slots = await svc.listSlots({});
    const slot = slots.find((s) => s.id === version.slotId);
    if (slot && GLOBAL_LAYERS.has(slot.layerType)) requirePlatformAdmin(request);

    const approved = await svc.approveVersion(id, request.userId!);
    return reply.send(approved);
  });

  app.post("/regional-brief/versions/:id/reject", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = rejectSchema.parse(request.body);
    const versions = await svc.listVersions(undefined, id);
    const version = versions[0];
    if (!version) return reply.code(404).send({ error: "regional_brief_version_not_found" });
    const slots = await svc.listSlots({});
    const slot = slots.find((s) => s.id === version.slotId);
    if (slot && GLOBAL_LAYERS.has(slot.layerType)) requirePlatformAdmin(request);

    const rejected = await svc.rejectVersion(id, request.userId!, body.reason);
    return reply.send(rejected);
  });

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.message, details: err.details ?? null });
    }
    throw err;
  });
}
