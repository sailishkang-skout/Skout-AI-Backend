import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, ilike, inArray, lt, ne, or, sql } from "drizzle-orm";
import { postCreditTransaction, schema, type Db } from "@skout/db";
import { getMemberPermissions, invalidateWorkspaceAccess, loadWorkspaceAccess, recordPrivilegedAction } from "@skout/auth";
import { PRODUCT_FEATURES, copsErrorBody, isOptInFeature, copsErrorStatus, resolveCorrelationId, type ProductFeature } from "@skout/shared";
import { copsIdempotencyStore, requireAnyCopsPermission, writeCopsAudit } from "../services/cops-platform.service.js";
import { withCopsIdempotentReply, type CopsCapturingReply } from "../services/cops-idempotent.js";
import { productAppUrl } from "../services/cops-onboarding.service.js";
import { buildEarlyAccessEmail, sendMail } from "../services/mail.service.js";
import {
  AccessError,
  applyPlanAndFeatures,
  approveAccessRequest,
  rejectAccessRequest,
  resendAccessCode,
  type AccessDeps,
} from "../services/access.service.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAN = z.enum(["full", "multichannel"]);
const featureShape = Object.fromEntries(PRODUCT_FEATURES.map((f) => [f, z.boolean()])) as Record<ProductFeature, z.ZodBoolean>;
// Approval must state every general feature; opt-in ones (WORKBOOKS_V2) may be left out and stay off.
const fullFeatures = z
  .object(Object.fromEntries(PRODUCT_FEATURES.map((f) => [f, isOptInFeature(f) ? z.boolean().optional() : z.boolean()])) as Record<ProductFeature, z.ZodTypeAny>)
  .strict();
const partialFeatures = z.object(featureShape).partial().strict();

const approveSchema = z
  .object({ plan: PLAN, credits: z.number().int().min(0).max(1_000_000), features: fullFeatures, note: z.string().trim().max(1000).optional() })
  .strict();
const rejectSchema = z.object({ note: z.string().trim().max(1000).optional() }).strict();
const featuresSchema = z.object({ features: partialFeatures }).strict();
const planSchema = z.object({ plan: PLAN }).strict();
const creditsSchema = z
  .object({
    amount: z.number().int().min(-1_000_000).max(1_000_000).refine((v) => v !== 0, "amount must not be zero"),
    reason: z.string().trim().min(1, "reason is required").max(1000),
  })
  .strict();
const listQuery = z.object({
  status: z.enum(["pending", "approved", "rejected", "all"]).default("pending"),
  cursor: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const workspaceQuery = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum(["pending", "invited", "active", "rejected"]).optional(),
  cursor: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

type IdBody = { Params: { id: string }; Body: unknown };
type Reply = CopsCapturingReply;

/**
 * Early access, COPS side (spec 2026-11-17): the self-signup queue (approve / reject / resend) and
 * plan, credit and feature-switch controls for any customer workspace. Mounted behind the ops-access
 * guard; acting on another workspace from the Skout workspace is the same documented cross-tenant
 * pattern as COPS-04 provisioning (docs/adr/0003-read-model-exceptions.md).
 */
export async function copsAccessRoutes(app: FastifyInstance, opts: { db: Db; deps?: AccessDeps }) {
  const { db } = opts;
  const perms = (ws: string, user: string) => getMemberPermissions(db, ws, user);
  const readGate = requireAnyCopsPermission(["access:manage", "onboarding:read"], perms);
  const writeGate = requireAnyCopsPermission(["access:manage"], perms);
  const creditGate = requireAnyCopsPermission(["credits:adjust"], perms);
  const idempotency = copsIdempotencyStore(db);
  const appUrl = productAppUrl(app.config.FRONTEND_URL ?? "http://localhost:3000");
  const deps: AccessDeps = opts.deps ?? {
    sendEmail: async (to, code, expiresAt) => {
      const result = await sendMail(app.config, buildEarlyAccessEmail({ to, code, url: `${appUrl}/early-access?code=${encodeURIComponent(code)}`, expiresAt }));
      return result.sent;
    },
  };

  const ctxOf = (request: { workspaceId?: string; userId?: string; headers: Record<string, unknown> }) => ({
    operatorWorkspaceId: request.workspaceId!,
    actorId: request.userId!,
    requestId: resolveCorrelationId(request.headers["x-request-id"] as string | undefined),
  });

  function invalid(reply: Reply, requestId: string, error: z.ZodError | string) {
    const fields =
      typeof error === "string"
        ? [{ path: "id", code: "invalid", message: error }]
        : error.issues.map((i) => ({ path: i.path.join(".") || "body", code: i.code, message: i.message }));
    return reply
      .status(copsErrorStatus("VALIDATION_FAILED"))
      .send(copsErrorBody({ code: "VALIDATION_FAILED", message: fields[0]?.message ?? "Invalid request", requestId, details: { fields } }));
  }

  async function run<T>(reply: Reply, requestId: string, fn: () => Promise<T>, onOk: (value: T) => unknown) {
    try {
      return onOk(await fn());
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.status(error.status).send(copsErrorBody({ code: error.code, message: error.message, requestId, details: error.details }));
      }
      throw error;
    }
  }

  // ---- queue -----------------------------------------------------------------------------

  async function requestDtos(rows: Array<typeof schema.accessRequests.$inferSelect>) {
    if (!rows.length) return [];
    const wsIds = rows.map((r) => r.workspaceId);
    const deciders = rows.map((r) => r.decidedBy).filter((x): x is string => !!x);
    const [wss, users] = await Promise.all([
      db.select({ id: schema.workspaces.id, name: schema.workspaces.name, status: schema.workspaces.accessStatus }).from(schema.workspaces).where(inArray(schema.workspaces.id, wsIds)),
      deciders.length ? db.select({ id: schema.users.id, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, deciders)) : Promise.resolve([]),
    ]);
    const ws = new Map(wss.map((w) => [w.id, w]));
    const by = new Map(users.map((u) => [u.id, u.email]));
    return rows.map((r) => ({
      id: r.id,
      workspace_id: r.workspaceId,
      workspace_name: ws.get(r.workspaceId)?.name ?? "",
      email: r.email,
      full_name: r.fullName,
      company: r.company,
      role_title: r.roleTitle,
      use_case: r.useCase,
      signup_method: r.signupMethod,
      status: r.status,
      workspace_status: ws.get(r.workspaceId)?.status ?? "pending",
      plan_code: r.planCode,
      credits_granted: r.creditsGranted,
      decided_at: r.decidedAt?.toISOString() ?? null,
      decided_by_email: r.decidedBy ? (by.get(r.decidedBy) ?? null) : null,
      decision_note: r.decisionNote,
      invite_email_sent_at: r.inviteEmailSentAt?.toISOString() ?? null,
      invite_code_expires_at: r.inviteCodeExpiresAt?.toISOString() ?? null,
      invite_code_redeemed_at: r.inviteCodeRedeemedAt?.toISOString() ?? null,
      created_at: r.createdAt.toISOString(),
    }));
  }

  app.get("/cops/access-requests", { preHandler: readGate }, async (request, reply) => {
    const parsed = listQuery.safeParse(request.query ?? {});
    if (!parsed.success) return invalid(reply as unknown as Reply, resolveCorrelationId(undefined), parsed.error);
    const { status, cursor, limit } = parsed.data;
    const conds = [];
    if (status !== "all") conds.push(eq(schema.accessRequests.status, status));
    if (cursor) conds.push(lt(schema.accessRequests.createdAt, new Date(cursor)));
    const rows = await db
      .select()
      .from(schema.accessRequests)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(schema.accessRequests.createdAt))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    return { data: await requestDtos(page), next_cursor: rows.length > limit ? page[page.length - 1]!.createdAt.toISOString() : null };
  });

  const one = async (id: string) => {
    const [row] = await db.select().from(schema.accessRequests).where(eq(schema.accessRequests.id, id)).limit(1);
    return row ? (await requestDtos([row]))[0] : null;
  };

  app.post<IdBody>(
    "/cops/access-requests/:id/approve",
    { preHandler: writeGate },
    withCopsIdempotentReply<IdBody>(idempotency, async (request, reply) => {
      const ctx = ctxOf(request);
      if (!UUID.test(request.params.id)) return invalid(reply, ctx.requestId, "Invalid id");
      const parsed = approveSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
      return run(reply, ctx.requestId, () => approveAccessRequest(db, ctx, request.params.id, parsed.data, deps), async () => ({ data: await one(request.params.id) }));
    })
  );

  app.post<IdBody>(
    "/cops/access-requests/:id/reject",
    { preHandler: writeGate },
    withCopsIdempotentReply<IdBody>(idempotency, async (request, reply) => {
      const ctx = ctxOf(request);
      if (!UUID.test(request.params.id)) return invalid(reply, ctx.requestId, "Invalid id");
      const parsed = rejectSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
      return run(reply, ctx.requestId, () => rejectAccessRequest(db, ctx, request.params.id, parsed.data), async () => ({ data: await one(request.params.id) }));
    })
  );

  app.post<IdBody>(
    "/cops/access-requests/:id/resend",
    { preHandler: writeGate },
    withCopsIdempotentReply<IdBody>(idempotency, async (request, reply) => {
      const ctx = ctxOf(request);
      if (!UUID.test(request.params.id)) return invalid(reply, ctx.requestId, "Invalid id");
      return run(reply, ctx.requestId, () => resendAccessCode(db, ctx, request.params.id, deps), async () => ({ data: await one(request.params.id) }));
    })
  );

  // ---- workspaces --------------------------------------------------------------------------

  const internalWorkspaceId = app.config.INTERNAL_WORKSPACE_ID ?? null;

  async function workspaceDtos(rows: Array<{ id: string; name: string; status: string; createdAt: Date }>) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [plans, balances, members, owners] = await Promise.all([
      db
        .select({ ws: schema.entitlements.workspaceId, value: schema.entitlements.value })
        .from(schema.entitlements)
        .where(and(inArray(schema.entitlements.workspaceId, ids), eq(schema.entitlements.key, "plan.code"))),
      db.select().from(schema.creditBalances).where(inArray(schema.creditBalances.workspaceId, ids)),
      db
        .select({ ws: schema.workspaceMembers.workspaceId, n: sql<number>`count(*)::int` })
        .from(schema.workspaceMembers)
        .where(inArray(schema.workspaceMembers.workspaceId, ids))
        .groupBy(schema.workspaceMembers.workspaceId),
      db
        .select({ ws: schema.workspaceMembers.workspaceId, email: schema.users.email })
        .from(schema.workspaceMembers)
        .innerJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
        .where(and(inArray(schema.workspaceMembers.workspaceId, ids), eq(schema.workspaceMembers.role, "owner"))),
    ]);
    const plan = new Map(plans.map((p) => [p.ws, typeof p.value === "string" ? p.value : null]));
    const bal = new Map(balances.map((b) => [b.workspaceId, b.balance]));
    const count = new Map(members.map((m) => [m.ws, m.n]));
    const owner = new Map<string, string>();
    for (const o of owners) if (!owner.has(o.ws)) owner.set(o.ws, o.email);
    return Promise.all(
      rows.map(async (r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        plan_code: plan.get(r.id) ?? null,
        credit_balance: bal.get(r.id) ?? 0,
        member_count: count.get(r.id) ?? 0,
        owner_email: owner.get(r.id) ?? null,
        features: (await loadWorkspaceAccess(db, r.id)).features,
        created_at: r.createdAt.toISOString(),
      }))
    );
  }

  app.get("/cops/workspaces", { preHandler: readGate }, async (request, reply) => {
    const parsed = workspaceQuery.safeParse(request.query ?? {});
    if (!parsed.success) return invalid(reply as unknown as Reply, resolveCorrelationId(undefined), parsed.error);
    const { q, status, cursor, limit } = parsed.data;
    const w = schema.workspaces;
    const conds = [ne(w.id, request.workspaceId!)];
    if (internalWorkspaceId) conds.push(ne(w.id, internalWorkspaceId));
    if (status) conds.push(eq(w.accessStatus, status));
    if (cursor) conds.push(lt(w.createdAt, new Date(cursor)));
    if (q) {
      const like = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
      conds.push(
        or(
          ilike(w.name, like),
          sql`exists (select 1 from workspace_members m join users u on u.id = m.user_id where m.workspace_id = ${w.id} and u.email ilike ${like})`
        )!
      );
    }
    const rows = await db
      .select({ id: w.id, name: w.name, status: w.accessStatus, createdAt: w.createdAt })
      .from(w)
      .where(and(...conds))
      .orderBy(desc(w.createdAt))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    return { data: await workspaceDtos(page), next_cursor: rows.length > limit ? page[page.length - 1]!.createdAt.toISOString() : null };
  });

  async function workspaceDetail(id: string) {
    const [row] = await db
      .select({ id: schema.workspaces.id, name: schema.workspaces.name, status: schema.workspaces.accessStatus, createdAt: schema.workspaces.createdAt })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, id))
      .limit(1);
    if (!row) return null;
    const [dto] = await workspaceDtos([row]);
    const txns = await db
      .select()
      .from(schema.creditTransactions)
      .where(eq(schema.creditTransactions.workspaceId, id))
      .orderBy(desc(schema.creditTransactions.seq))
      .limit(20);
    return {
      ...dto!,
      transactions: txns.map((t) => ({
        id: t.id,
        amount: t.amount,
        kind: t.kind,
        reason: t.reason,
        balance_after: t.balanceAfter,
        created_at: t.createdAt.toISOString(),
      })),
    };
  }

  const notFound = (reply: Reply, requestId: string) =>
    reply.status(404).send(copsErrorBody({ code: "NOT_FOUND", message: "Workspace not found", requestId }));

  app.get<{ Params: { id: string } }>("/cops/workspaces/:id", { preHandler: readGate }, async (request, reply) => {
    const requestId = resolveCorrelationId(request.headers["x-request-id"] as string | undefined);
    if (!UUID.test(request.params.id)) return notFound(reply as unknown as Reply, requestId);
    const detail = await workspaceDetail(request.params.id);
    if (!detail) return notFound(reply as unknown as Reply, requestId);
    return { data: detail };
  });

  async function exists(id: string) {
    const [row] = await db.select({ id: schema.workspaces.id }).from(schema.workspaces).where(eq(schema.workspaces.id, id)).limit(1);
    return !!row;
  }

  async function auditChange(ctx: ReturnType<typeof ctxOf>, workspaceId: string, action: string, before: unknown, after: unknown) {
    await writeCopsAudit(db, {
      tenantId: ctx.operatorWorkspaceId,
      actor: { type: "user", id: ctx.actorId },
      entityType: "workspace",
      entityId: workspaceId,
      action,
      before,
      after,
      correlationId: ctx.requestId,
      sourceChannel: "api",
    });
    await recordPrivilegedAction(db, {
      workspaceId,
      actorId: ctx.actorId,
      action: "entitlement.platform_grant",
      entityType: "workspace",
      entityId: workspaceId,
      beforeState: before as Record<string, unknown>,
      afterState: after as Record<string, unknown>,
    });
  }

  app.put<IdBody>(
    "/cops/workspaces/:id/features",
    { preHandler: writeGate },
    withCopsIdempotentReply<IdBody>(idempotency, async (request, reply) => {
      const ctx = ctxOf(request);
      if (!UUID.test(request.params.id) || !(await exists(request.params.id))) return notFound(reply, ctx.requestId);
      const parsed = featuresSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
      const before = (await loadWorkspaceAccess(db, request.params.id)).features;
      await db.transaction(async (tx) => applyPlanAndFeatures(tx as unknown as Db, request.params.id, { features: parsed.data.features }));
      invalidateWorkspaceAccess(request.params.id);
      await auditChange(ctx, request.params.id, "access.features_changed", { features: before }, { features: parsed.data.features });
      return { data: await workspaceDetail(request.params.id) };
    })
  );

  app.put<IdBody>(
    "/cops/workspaces/:id/plan",
    { preHandler: writeGate },
    withCopsIdempotentReply<IdBody>(idempotency, async (request, reply) => {
      const ctx = ctxOf(request);
      if (!UUID.test(request.params.id) || !(await exists(request.params.id))) return notFound(reply, ctx.requestId);
      const parsed = planSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
      await applyPlanAndFeatures(db, request.params.id, { plan: parsed.data.plan });
      await auditChange(ctx, request.params.id, "access.plan_changed", null, { plan: parsed.data.plan });
      return { data: await workspaceDetail(request.params.id) };
    })
  );

  app.post<IdBody>(
    "/cops/workspaces/:id/credits",
    { preHandler: creditGate },
    withCopsIdempotentReply<IdBody>(idempotency, async (request, reply) => {
      const ctx = ctxOf(request);
      if (!UUID.test(request.params.id) || !(await exists(request.params.id))) return notFound(reply, ctx.requestId);
      const parsed = creditsSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
      const header = request.headers["idempotency-key"];
      try {
        const posted = await postCreditTransaction(db, {
          workspaceId: request.params.id,
          amount: parsed.data.amount,
          kind: parsed.data.amount > 0 ? "grant" : "adjustment",
          action: "admin_topup",
          reason: parsed.data.reason,
          actor: { type: "user", id: ctx.actorId },
          idempotencyKey: `cops-access-credits:${String(Array.isArray(header) ? header[0] : header)}`,
          correlationId: ctx.requestId,
        });
        await writeCopsAudit(db, {
          tenantId: ctx.operatorWorkspaceId,
          actor: { type: "user", id: ctx.actorId },
          entityType: "credit_wallet",
          entityId: request.params.id,
          action: parsed.data.amount > 0 ? "credits.granted" : "credits.adjusted",
          after: { amount: parsed.data.amount, balance: posted.balance, transaction_id: posted.transaction.id },
          reason: parsed.data.reason,
          correlationId: ctx.requestId,
          sourceChannel: "api",
        });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "INSUFFICIENT_CREDITS") {
          return reply.status(409).send(copsErrorBody({ code: "BUSINESS_STATE_CONFLICT", message: "That would take the balance below zero", requestId: ctx.requestId }));
        }
        throw err;
      }
      return reply.status(201).send({ data: await workspaceDetail(request.params.id) });
    })
  );
}
