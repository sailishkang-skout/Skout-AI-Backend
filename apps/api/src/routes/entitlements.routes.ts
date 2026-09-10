import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { enforcePermission } from "@skout/auth";
import { errorResponse } from "../utils/http.js";
import { buildEntitlementsService } from "../services/entitlements.service.js";

const setSchema = z.object({
  value: z.unknown(),
});

/**
 * §5.1 / §11.1 / §16 Task 35 (Enterprise Completion Plan) — entitlements read/write API. Reads
 * are open to any authenticated workspace member (same posture as GET /billing — seeing your
 * own plan limits isn't privileged); writes are owner/admin only, matching the role bar this
 * codebase already uses for other plan/billing-adjacent actions (see team.routes.ts).
 */
export async function entitlementsRoutes(app: FastifyInstance) {
  const service = () => buildEntitlementsService(app.db ?? null);

  app.get("/entitlements", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const svc = service();
    if (!svc) return reply.send({ data: [] });

    const data = await svc.list(request.workspaceId);
    return reply.send({ data });
  });

  async function shadowBillingManage(workspaceId: string, userId: string | undefined, action: string) {
    if (!app.db || !userId) return;
    await enforcePermission(app.db, workspaceId, userId, "billing:manage", {
      enforce: app.config.RBAC_ENFORCEMENT_ENABLED,
      onShadowDeny: (info) =>
        app.log.warn(info, `RBAC shadow-mode: billing:manage would have been denied (${action})`),
    });
  }

  app.put<{ Params: { key: string } }>("/entitlements/:key", async (request, reply) => {
    if (!request.workspaceId || !request.role) return reply.code(401).send(errorResponse("Unauthorized", 401));
    if (!["owner", "admin"].includes(request.role)) {
      return reply.code(403).send(errorResponse("Requires role: owner or admin", 403));
    }
    await shadowBillingManage(request.workspaceId, request.userId, "set entitlement");
    const svc = service();
    if (!svc) return reply.code(503).send(errorResponse("Database unavailable", 503));

    const parsed = setSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send(errorResponse("Invalid entitlement payload", 400, parsed.error.flatten()));
    }

    const entitlement = await svc.set(request.workspaceId, request.params.key, parsed.data.value);
    return reply.send({ data: entitlement });
  });

  app.delete<{ Params: { key: string } }>("/entitlements/:key", async (request, reply) => {
    if (!request.workspaceId || !request.role) return reply.code(401).send(errorResponse("Unauthorized", 401));
    if (!["owner", "admin"].includes(request.role)) {
      return reply.code(403).send(errorResponse("Requires role: owner or admin", 403));
    }
    await shadowBillingManage(request.workspaceId, request.userId, "remove entitlement");
    const svc = service();
    if (!svc) return reply.code(503).send(errorResponse("Database unavailable", 503));

    await svc.remove(request.workspaceId, request.params.key);
    return reply.code(204).send();
  });
}
