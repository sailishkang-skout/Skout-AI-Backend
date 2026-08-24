import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getEvidence, recordEvidence } from "../services/evidence.service.js";
import { errorResponse } from "../utils/http.js";

const recordSchema = z.object({
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  attribute: z.string().min(1),
  value: z.unknown(),
  source: z.string().min(1),
  observedAt: z.coerce.date(),
  confidence: z.number().min(0).max(1),
  method: z.string().optional(),
  region: z.string().optional(),
  authority: z.string().optional(),
  corroborationCount: z.number().int().min(1).optional(),
  validation: z.string().optional(),
  freshnessExpiresAt: z.coerce.date().optional(),
  chosenValue: z.unknown().optional(),
  resolutionRuleOrModelVersion: z.string().optional(),
  alternatives: z.unknown().optional(),
  resolutionReason: z.string().optional(),
  permittedPurpose: z.string().optional(),
  consentBasis: z.string().optional(),
  channelConstraints: z.unknown().optional(),
  retentionUntil: z.coerce.date().optional(),
});

const listQuerySchema = z.object({
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  attribute: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** §5.3 — the Evidence Ledger's HTTP surface. Read is open to any workspace member; writes require an authenticated workspace context (no role gate — any service/user acting on behalf of the workspace may record evidence, same as most write paths in this API). */
export async function evidenceRoutes(app: FastifyInstance) {
  app.post("/evidence", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    if (!app.db) return reply.code(503).send(errorResponse("Database unavailable", 503));

    const parsed = recordSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send(errorResponse("Invalid evidence payload", 400, parsed.error.flatten()));
    }

    const row = await recordEvidence(app.db, { workspaceId: request.workspaceId, ...parsed.data, value: parsed.data.value ?? null });
    return reply.code(201).send({ data: row });
  });

  app.get("/evidence", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));

    const parsed = listQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.status(400).send(errorResponse("Invalid query", 400, parsed.error.flatten()));
    }
    if (!app.db) return reply.send({ data: [], total: 0 });

    const { entityType, entityId, attribute, limit } = parsed.data;
    const data = await getEvidence(app.db, { workspaceId: request.workspaceId, entityType, entityId, attribute }, limit);
    return reply.send({ data, total: data.length });
  });
}
