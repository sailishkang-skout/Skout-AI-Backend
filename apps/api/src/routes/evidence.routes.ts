import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getEvidence, recordEvidence } from "../services/evidence.service.js";
import { errorResponse } from "../utils/http.js";
import {
  mapEmailIntelObservationToCanonical,
  type EmailIntelEvidenceObservation,
} from "../services/email-intel-evidence-map.js";

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

const emailIntelObsSchema = z.object({
  email: z.string().email(),
  domain: z.string().nullable().optional(),
  source: z.string().min(1),
  outcome: z.string().min(1),
  responseCode: z.number().nullable().optional(),
  responseMessage: z.string().nullable().optional(),
  smtpValid: z.boolean().nullable().optional(),
  mailboxExists: z.boolean().nullable().optional(),
  catchAll: z.boolean().nullable().optional(),
  provider: z.string().nullable().optional(),
  verificationId: z.string().nullable().optional(),
  requestId: z.string().nullable().optional(),
  metadata: z.unknown().optional(),
  rawEvidence: z.unknown().optional(),
  createdAt: z.union([z.string(), z.coerce.date()]).nullable().optional(),
  externalId: z.string().nullable().optional(),
});

const emailIntelIngestSchema = z.union([
  emailIntelObsSchema,
  z.object({ observations: z.array(emailIntelObsSchema).min(1).max(500) }),
]);

/** §5.3 — the Evidence Ledger's HTTP surface. */
export async function evidenceRoutes(app: FastifyInstance) {
  app.post("/evidence", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    if (!app.db) return reply.code(503).send(errorResponse("Database unavailable", 503));

    const parsed = recordSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send(errorResponse("Invalid evidence payload", 400, parsed.error.flatten()));
    }

    const row = await recordEvidence(app.db, {
      workspaceId: request.workspaceId,
      ...parsed.data,
      value: parsed.data.value ?? null,
    });
    return reply.code(201).send({ data: row });
  });

  /**
   * §5.3 Email-Intel merge — ingest observation(s) from Email-Intelligence-Tool's
   * evidence_ledger shape into the canonical workspace-scoped ledger.
   */
  app.post("/evidence/ingest/email-intel", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    if (!app.db) return reply.code(503).send(errorResponse("Database unavailable", 503));

    const parsed = emailIntelIngestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply
        .status(400)
        .send(errorResponse("Invalid email-intel evidence payload", 400, parsed.error.flatten()));
    }

    const observations: EmailIntelEvidenceObservation[] =
      "observations" in parsed.data ? parsed.data.observations : [parsed.data];

    const written = [];
    for (const obs of observations) {
      const input = mapEmailIntelObservationToCanonical(request.workspaceId, obs);
      written.push(await recordEvidence(app.db, input));
    }
    return reply.code(201).send({ data: written, total: written.length });
  });

  app.get("/evidence", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));

    const parsed = listQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.status(400).send(errorResponse("Invalid query", 400, parsed.error.flatten()));
    }
    if (!app.db) return reply.send({ data: [], total: 0 });

    const { entityType, entityId, attribute, limit } = parsed.data;
    const data = await getEvidence(
      app.db,
      { workspaceId: request.workspaceId, entityType, entityId, attribute },
      limit
    );
    return reply.send({ data, total: data.length });
  });
}
