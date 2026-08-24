import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, enforcePermission } from "@skout/auth";
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

    // §5.1 / §11.1 — fine-grained RBAC check alongside the role gate above. requireRole()
    // above is what actually enforces access today (unchanged); this is shadow-mode by
    // default — see enforcePermission's own doc comment for why enforcing before
    // backfill-rbac.ts has run would deny every request outright.
    if (app.db && request.userId) {
      await enforcePermission(app.db, workspaceId, request.userId, "data:manage_retention", {
        enforce: app.config.RBAC_ENFORCEMENT_ENABLED,
        onShadowDeny: (info) =>
          app.log.warn(info, "RBAC shadow-mode: data:manage_retention would have been denied (create)"),
      });
    }

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

    // §5.1 / §11.1 — same shadow-mode RBAC check as the create route above.
    if (app.db && request.userId) {
      await enforcePermission(app.db, workspaceId, request.userId, "data:manage_retention", {
        enforce: app.config.RBAC_ENFORCEMENT_ENABLED,
        onShadowDeny: (info) =>
          app.log.warn(info, "RBAC shadow-mode: data:manage_retention would have been denied (set-active)"),
      });
    }

    const body = z.object({ isActive: z.boolean() }).parse(request.body);
    const rule = await svc.setActive(workspaceId, ruleId, body.isActive);
    return reply.send(rule);
  });
}
