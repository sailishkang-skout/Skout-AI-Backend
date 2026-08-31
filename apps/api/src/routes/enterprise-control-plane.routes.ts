import type { FastifyInstance } from "fastify";
import { errorResponse } from "../utils/http.js";
import { getEnterpriseControlPlane } from "../services/enterprise-control-plane.service.js";
import { journeyMetricsSnapshot } from "../services/journey-metrics.js";

function requireAdmin(request: { role?: string | null }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
  if (!request.role || !["owner", "admin"].includes(request.role)) {
    return reply.code(403).send(errorResponse("Requires role: owner or admin", 403));
  }
  return null;
}

/** §17.18 — Enterprise Control Plane + §11.3 journey visibility. */
export async function enterpriseControlPlaneRoutes(app: FastifyInstance) {
  app.get("/admin/control-plane", async (request, reply) => {
    if (requireAdmin(request, reply)) return;
    if (!request.workspaceId || !app.db) return reply.code(401).send(errorResponse("Unauthorized", 401));

    const data = await getEnterpriseControlPlane(app.db, app.config, request.workspaceId);
    return reply.send({ data });
  });

  app.get("/admin/journey-metrics", async (request, reply) => {
    if (requireAdmin(request, reply)) return;
    return reply.send({ data: journeyMetricsSnapshot() });
  });
}
