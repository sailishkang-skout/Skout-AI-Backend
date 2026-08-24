import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError } from "@skout/auth";
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

  app.get("/deals/:id/buying-committee", async (request) => {
    const dealId = parseIdParam(request);
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    return { members: await svc.listForDeal(workspaceId, dealId) };
  });

  app.post("/deals/:id/buying-committee/members", async (request, reply) => {
    requireRole(request, ["owner", "admin", "member"]);
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
    const memberId = parseIdParam(request);
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    await svc.removeMember(workspaceId, memberId);
    return reply.code(204).send();
  });
}
