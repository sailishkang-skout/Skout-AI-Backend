import type { FastifyInstance } from "fastify";
import { computeCroRollup } from "../services/cro-summary.service.js";
import { errorResponse } from "../utils/http.js";

/**
 * R19.1 — Admin-gated rollup API. The exact `GET /api/v1/cro/summary` path + metrics the AC
 * specifies (activation, response rate, top-risk accounts, TAM coverage), 403 for `member` role.
 * Read-only; no write actions, per the AC.
 */
export async function croRoutes(app: FastifyInstance) {
  app.get("/cro/summary", async (request, reply) => {
    if (!request.workspaceId) {
      return reply.code(401).send(errorResponse("Not authenticated", 401));
    }
    if (!request.role || !["owner", "admin"].includes(request.role)) {
      return reply.code(403).send(errorResponse("Requires role: owner or admin", 403));
    }
    if (!app.db) {
      return reply.code(500).send(errorResponse("Database not available", 500));
    }

    const rollup = await computeCroRollup(app.db, app.config, request.workspaceId);
    return reply.send({ data: rollup });
  });
}
