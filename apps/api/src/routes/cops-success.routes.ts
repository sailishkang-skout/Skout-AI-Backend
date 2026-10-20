/**
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md (COPS-11 additions).
 *   - Tables touched directly: companies (read; update of csm_id)
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: an admin sets the account's CSM, one of the Bible's Success fields.
 *   - Review date: 2026-10-20
 */
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@skout/db";
import { getMemberPermissions } from "@skout/auth";
import { HttpError } from "../utils/http.js";
import { requireAnyCopsPermission } from "../services/cops-platform.service.js";
import { workspaceManageGate } from "./crm-admin-gate.js";
import { getAccountHealth, getAccountHealthHistory, getHealthModel, HEALTH_DIMENSIONS, recordAccountHealth, saveHealthModel } from "../services/cops-health.service.js";
import { installSuccessPlaybooks, listPlaybookEnrollments, PLAYBOOK_TEMPLATES } from "../services/cops-playbooks.service.js";
import { getCustomerSuccessOverview } from "../services/cops-success-overview.service.js";

const { companies, workspaceMembers, auditLogs } = schema;

/** COPS-11 customer success: account health, the CS overview, the health model and playbooks. */
export async function copsSuccessRoutes(app: FastifyInstance) {
  function db() {
    if (!app.db) throw new HttpError("Database not available", 503);
    return app.db;
  }
  const read = { preHandler: requireAnyCopsPermission(["crm:read", "crm:manage"], (ws, user) => getMemberPermissions(db(), ws, user)) };
  const write = { preHandler: requireAnyCopsPermission(["crm:manage", "workspace:manage"], (ws, user) => getMemberPermissions(db(), ws, user)) };
  const manage = { preHandler: workspaceManageGate(app) };
  const accountParams = z.object({ id: z.string().uuid() });

  /** The latest score with every contributing factor (null before the first computation). */
  app.get("/accounts/:id/health", read, async (request) => {
    const { id } = accountParams.parse(request.params);
    const [acc] = await db().select({ csmId: companies.csmId }).from(companies).where(and(eq(companies.id, id), eq(companies.workspaceId, request.workspaceId!))).limit(1);
    if (!acc) throw new HttpError("account_not_found", 404);
    return { data: { health: await getAccountHealth(db(), request.workspaceId!, id), csmId: acc.csmId } };
  });

  /** Score history for the trend. */
  app.get("/accounts/:id/health/history", read, async (request) => {
    const { id } = accountParams.parse(request.params);
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(730).default(180) }).parse(request.query ?? {});
    return { data: await getAccountHealthHistory(db(), request.workspaceId!, id, days) };
  });

  /** Recomputes now (the daily sweep does it too). */
  app.post("/accounts/:id/health/recompute", write, async (request) => {
    const { id } = accountParams.parse(request.params);
    const r = await recordAccountHealth(db(), request.workspaceId!, id, { requestId: randomUUID() });
    return { data: { score: r.score, state: r.state, renewalRisk: r.renewalRisk, newSignals: r.newSignals } };
  });

  /** Sets or clears the account's CSM; they must be a member of this workspace. Audited. */
  app.put("/accounts/:id/csm", write, async (request) => {
    const { id } = accountParams.parse(request.params);
    const { csm_id } = z.object({ csm_id: z.string().uuid().nullable() }).parse(request.body ?? {});
    const ws = request.workspaceId!;
    if (csm_id) {
      const [m] = await db().select({ id: workspaceMembers.userId }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, ws), eq(workspaceMembers.userId, csm_id))).limit(1);
      if (!m) throw new HttpError("csm_not_a_member", 422);
    }
    return db().transaction(async (tx) => {
      const [before] = await tx.select({ csmId: companies.csmId }).from(companies).where(and(eq(companies.id, id), eq(companies.workspaceId, ws))).for("update").limit(1);
      if (!before) throw new HttpError("account_not_found", 404);
      await tx.update(companies).set({ csmId: csm_id }).where(eq(companies.id, id));
      await tx.insert(auditLogs).values({
        workspaceId: ws,
        actorType: "user",
        actorId: request.userId ?? null,
        action: "account.csm_changed",
        entityType: "company",
        entityId: id,
        beforeState: { csmId: before.csmId },
        afterState: { csmId: csm_id },
        reason: csm_id ? "CSM assigned" : "CSM cleared",
      });
      return { data: { csmId: csm_id } };
    });
  });

  /** The Customer Success screen. */
  app.get("/customer-success/overview", read, async (request) => ({ data: await getCustomerSuccessOverview(db(), request.workspaceId!) }));

  /** Playbook enrollments, optionally for one account. */
  app.get("/customer-success/playbooks/enrollments", read, async (request) => {
    const q = z.object({ account_id: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(200).optional() }).parse(request.query ?? {});
    return { data: await listPlaybookEnrollments(db(), request.workspaceId!, { accountId: q.account_id, limit: q.limit }) };
  });

  /** The playbook templates and which this workspace has installed. */
  app.get("/customer-success/playbooks", read, async (request) => {
    const rows = await db().select({ id: schema.automations.id, key: schema.automations.templateKey, status: schema.automations.status }).from(schema.automations).where(eq(schema.automations.workspaceId, request.workspaceId!));
    const byKey = new Map(rows.filter((r) => r.key).map((r) => [r.key, r]));
    return { data: PLAYBOOK_TEMPLATES.map((t) => ({ key: t.key, name: t.name, description: t.description, automationId: byKey.get(t.key)?.id ?? null, status: byKey.get(t.key)?.status ?? null })) };
  });

  app.post("/customer-success/playbooks/install", manage, async (request) => ({ data: await installSuccessPlaybooks(db(), request.workspaceId!, request.userId ?? null) }));

  /** The live health model (weights, thresholds, parameters). */
  app.get("/customer-success/model", read, async (request) => ({ data: await getHealthModel(db(), request.workspaceId!) }));

  /** Saves a new model version. Audited. */
  app.put("/customer-success/model", manage, async (request) => {
    const weight = z.number().int().min(0).max(100);
    const body = z
      .object({
        weights: z.object(Object.fromEntries(HEALTH_DIMENSIONS.map((d) => [d, weight.optional()])) as Record<(typeof HEALTH_DIMENSIONS)[number], z.ZodOptional<typeof weight>>).optional(),
        thresholds: z.object({ healthy: z.number().int().min(1).max(100).optional(), atRisk: z.number().int().min(0).max(99).optional() }).optional(),
        params: z.object({ quietDays: z.number().int().min(1).max(365).optional(), renewalWindowDays: z.number().int().min(7).max(365).optional(), ticketHeavyOpen: z.number().int().min(1).max(50).optional() }).optional(),
      })
      .parse(request.body ?? {});
    const ws = request.workspaceId!;
    const model = await saveHealthModel(db(), ws, body as never, request.userId ?? null);
    await db().insert(auditLogs).values({ workspaceId: ws, actorType: "user", actorId: request.userId ?? null, action: "health_model.updated", entityType: "workspace", entityId: ws, afterState: model, reason: `Health model v${model.version}` });
    return { data: model };
  });
}
