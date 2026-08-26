import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, enforcePermission } from "@skout/auth";
import { parseIdParam } from "../utils/http.js";
import { requireRole } from "../utils/require-role.js";
import { buildBuyingCommitteeService } from "../services/buying-committee.service.js";

const memberInputSchema = z.object({
  contactId: z.string().uuid(),
  role: z.enum(["economic_buyer", "champion", "influencer", "blocker", "user", "unknown"]).optional(),
  influence: z.number().int().min(1).max(5).optional(),
  notes: z.string().optional(),
});

/** §8.12 CRM Intelligence — BuyingCommittee endpoints, deal-scoped for Wave 1. */
export async function buyingCommitteeRoutes(app: FastifyInstance) {
  const service = () => {
    const db = app.db ?? null;
    return buildBuyingCommitteeService(db);
  };

  async function shadowCrmManage(request: { userId?: string; workspaceId?: string }, action: string) {
    const workspaceId = request.workspaceId ?? "unknown";
    if (app.db && request.userId) {
      await enforcePermission(app.db, workspaceId, request.userId, "crm:manage", {
        enforce: app.config.RBAC_ENFORCEMENT_ENABLED,
        onShadowDeny: (info) =>
          app.log.warn(info, `RBAC shadow-mode: crm:manage would have been denied (${action})`),
      });
    }
  }

  app.get("/deals/:id/buying-committee", async (request) => {
    const dealId = parseIdParam(request);
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    return { members: await svc.listForDeal(workspaceId, dealId) };
  });

  app.post("/deals/:id/buying-committee/members", async (request, reply) => {
    requireRole(request, ["owner", "admin", "member"]);
    await shadowCrmManage(request, "add buying-committee member");
    const dealId = parseIdParam(request);
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const input = memberInputSchema.parse(request.body);
    const member = await svc.addMemberToDeal(workspaceId, dealId, input);
    return reply.code(201).send(member);
  });

  app.delete("/buying-committee/members/:id", async (request, reply) => {
    requireRole(request, ["owner", "admin", "member"]);
    await shadowCrmManage(request, "remove buying-committee member");
    const memberId = parseIdParam(request);
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    await svc.removeMember(workspaceId, memberId);
    return reply.code(204).send();
  });
}
