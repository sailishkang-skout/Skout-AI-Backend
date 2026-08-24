import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError } from "@skout/auth";
import { parseIdParam } from "../utils/http.js";
import { requireRole } from "../utils/require-role.js";
import { buildRetentionRulesService } from "../services/retention-rules.service.js";

const ruleInputSchema = z.object({
  name: z.string().min(1),
  classification: z.enum(["marketing", "contractual"]),
  entityType: z.string().min(1),
  criteria: z.record(z.unknown()),
  isActive: z.boolean().optional(),
});

/** §8.12 CRM Intelligence — RetentionRule endpoints (marketing-vs-contractual classification). */
export async function retentionRulesRoutes(app: FastifyInstance) {
  const service = () => {
    const db = app.db ?? null;
    return buildRetentionRulesService(db);
  };

  app.get("/retention-rules", async (request) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const query = z.object({ entityType: z.string().optional() }).parse(request.query);
    return { rules: await svc.list(workspaceId, query.entityType) };
  });

  app.post("/retention-rules", async (request, reply) => {
    requireRole(request, ["owner", "admin"]);
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const input = ruleInputSchema.parse(request.body);
    const rule = await svc.create(workspaceId, request.userId, input);
    return reply.code(201).send(rule);
  });

  app.patch("/retention-rules/:id/active", async (request, reply) => {
    requireRole(request, ["owner", "admin"]);
    const ruleId = parseIdParam(request);
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const body = z.object({ isActive: z.boolean() }).parse(request.body);
    const rule = await svc.setActive(workspaceId, ruleId, body.isActive);
    return reply.send(rule);
  });
}
