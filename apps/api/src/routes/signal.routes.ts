import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { listSignalsForEntity } from "../services/signal.service.js";
import { errorResponse } from "../utils/http.js";

const listSignalsQuerySchema = z.object({
  entityId: z.string().min(1),
  entityType: z.string().optional(),
  signalType: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/** Unified signal timeline (R11.2) — corpus-scoped, not workspace-scoped. */
export async function signalRoutes(app: FastifyInstance) {
  app.get("/signals", async (request, reply) => {
    const parsed = listSignalsQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.status(400).send(errorResponse("entityId is required", 400, parsed.error.flatten()));
    }
    const { entityId, entityType, signalType, limit } = parsed.data;

    if (!app.db) return reply.send({ entityId, entityType: entityType ?? "company", data: [], total: 0 });

    const data = await listSignalsForEntity(app.db, entityId, { entityType, signalType, limit });
    return reply.send({ entityId, entityType: entityType ?? "company", data, total: data.length });
  });
}
