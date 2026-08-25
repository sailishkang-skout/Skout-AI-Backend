import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createRegionalBriefService,
  isPlatformAdmin,
  REGIONAL_BRIEF_LAYER_TYPES,
  REGIONAL_BRIEF_FIELD_CATEGORIES,
} from "../services/regional-brief.service.js";
import { HttpError } from "../utils/http.js";

const GLOBAL_LAYERS = new Set(["global", "region", "country", "industry"]);

const createSlotSchema = z.object({
  layerType: z.enum(REGIONAL_BRIEF_LAYER_TYPES),
  countryIso: z.string().length(2).optional(),
  regionCode: z.string().optional(),
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
  const svc = createRegionalBriefService(app.db);

  function requirePlatformAdmin(request: { userEmail?: string }) {
    if (!isPlatformAdmin(app.config, request.userEmail)) {
      throw new HttpError("Requires platform-admin access", 403);
    }
  }

  app.get("/regional-brief/admin-check", async (request, reply) => {
    return reply.send({ platformAdmin: isPlatformAdmin(app.config, request.userEmail) });
  });

  app.get("/regional-brief/resolve", async (request, reply) => {
    const query = z.object({ country: z.string().length(2), industry: z.string().optional() }).parse(request.query);
    const resolved = await svc.resolveRegionalBrief({
      countryIso: query.country,
      industry: query.industry,
      workspaceId: request.workspaceId,
    });
    return reply.send(resolved);
  });

  app.post("/regional-brief/slots", async (request, reply) => {
    const body = createSlotSchema.parse(request.body);
    if (GLOBAL_LAYERS.has(body.layerType)) {
      requirePlatformAdmin(request);
    }
    const slot = await svc.findOrCreateSlot({
      ...body,
      workspaceId: body.workspaceId ?? (body.layerType === "tenant" || body.layerType === "outcome_learning" ? request.workspaceId : undefined),
    });
    return reply.code(201).send(slot);
  });

  app.post("/regional-brief/slots/:id/versions", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = createVersionSchema.parse(request.body);

    // Look up the slot first to know which admin tier applies.
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

  app.post("/regional-brief/versions/:id/approve", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    // Same admin-tier check as slot creation: look up the version's slot.
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
