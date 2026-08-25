import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  computeSignalStackScore,
  listSignalsForEntity,
  listWorkspaceAccountSignals,
  recordSignal,
  signalStackWeightsFromEnv,
} from "../services/signal.service.js";
import { errorResponse } from "../utils/http.js";

const listSignalsQuerySchema = z.object({
  entityId: z.string().min(1),
  entityType: z.string().optional(),
  signalType: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const createSignalBodySchema = z.object({
  entityId: z.string().min(1),
  entityType: z.string().max(50).optional(),
  signalType: z.string().min(1).max(100),
  reason: z.string().max(2000).optional(),
  score: z.number().optional(),
  confidence: z.number().min(0).max(1).optional(),
  source: z.string().max(100).optional(),
  observedAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
  activationPaths: z.array(z.enum(["activate", "add_to_list", "enroll_sequence"])).optional(),
});

const listAccountSignalsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** Unified signal timeline (R11.2) — corpus-scoped, not workspace-scoped. */
export async function signalRoutes(app: FastifyInstance) {
  /** 8.5 — Signal Center: every one of the workspace's activated accounts that has a live
   * signal, ranked by stacking score. Must be registered before /signals/:something-shaped
   * routes if any are added later — Fastify matches "/signals/accounts" as its own literal path. */
  app.get("/signals/accounts", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const parsed = listAccountSignalsQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.status(400).send(errorResponse("invalid query", 400, parsed.error.flatten()));
    }
    if (!app.db) return reply.send({ data: [], total: 0 });

    const data = await listWorkspaceAccountSignals(app.db, app.config, workspaceId, { limit: parsed.data.limit });
    return reply.send({ data, total: data.length });
  });

  app.get("/signals", async (request, reply) => {
    const parsed = listSignalsQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.status(400).send(errorResponse("entityId is required", 400, parsed.error.flatten()));
    }
    const { entityId, entityType, signalType, limit } = parsed.data;

    const weights = signalStackWeightsFromEnv(app.config);

    if (!app.db) {
      return reply.send({
        entityId,
        entityType: entityType ?? "company",
        data: [],
        total: 0,
        stackScore: computeSignalStackScore([], { weights }),
      });
    }

    const data = await listSignalsForEntity(app.db, entityId, { entityType, signalType, limit });
    return reply.send({
      entityId,
      entityType: entityType ?? "company",
      data,
      total: data.length,
      stackScore: computeSignalStackScore(data, { weights }),
    });
  });

  /** Manual signal creation — e.g. a rep tagging a custom signal from the UI. */
  app.post("/signals", async (request, reply) => {
    const parsed = createSignalBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send(errorResponse("invalid signal payload", 400, parsed.error.flatten()));
    }
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });

    const signal = await recordSignal(app.db, {
      ...parsed.data,
      source: parsed.data.source ?? "manual",
      observedAt: parsed.data.observedAt ? new Date(parsed.data.observedAt) : undefined,
      expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : undefined,
    });
    return reply.status(201).send({ signal });
  });
}
