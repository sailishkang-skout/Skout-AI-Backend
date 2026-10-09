import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { copsErrorBody, copsErrorStatus, resolveCorrelationId } from "@skout/shared";
import { getMemberPermissions } from "@skout/auth";
import { copsIdempotencyStore, requireAnyCopsPermission, writeCopsAudit } from "../services/cops-platform.service.js";
import { withCopsIdempotentReply, type CopsCapturingReply } from "../services/cops-idempotent.js";
import { listConfig } from "../services/cops-admin-config.service.js";
import { loadCopsModules } from "../services/cops-feature-flags.js";
import { listRetentionRuns, loadDataInventory, RETENTION_TARGETS, RetentionError, startRetentionRun } from "../services/cops-retention.service.js";
import { loadOpsMetrics } from "../services/cops-ops-metrics.service.js";

const { copsActivationTemplates } = schema;

const retentionRunSchema = z
  .object({
    mode: z.enum(["dry_run", "apply"]),
    dry_run_id: z.string().uuid().optional(),
    reason: z.string().trim().max(1000).optional(),
  })
  .strict();

const milestoneSchema = z
  .object({
    key: z.string().regex(/^[a-z0-9_]{1,64}$/, "Lowercase letters, digits and _"),
    label: z.string().trim().min(1).max(120),
    weight: z.number().int().min(0).max(100),
    required: z.boolean(),
    source: z.enum(["event", "manual"]),
    event_types: z.array(z.string().min(1).max(64)).max(10),
  })
  .strict();
const activationVersionSchema = z
  .object({
    segment: z.enum(["smb", "mid_market", "enterprise"]).nullable().optional(),
    milestones: z.array(milestoneSchema).min(1).max(30),
    reason: z.string().trim().min(1, "reason is required").max(1000),
  })
  .strict()
  .superRefine((v, ctx) => {
    const keys = v.milestones.map((m) => m.key);
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", path: ["milestones"], message: "Milestone keys must be unique" });
    // Login alone never activates (COPS-05): at least one required milestone other than first_login.
    if (!v.milestones.some((m) => m.required && m.key !== "first_login")) {
      ctx.addIssue({ code: "custom", path: ["milestones"], message: "At least one required milestone other than first login is needed" });
    }
    const weight = v.milestones.reduce((n, m) => n + m.weight, 0);
    if (weight !== 100) ctx.addIssue({ code: "custom", path: ["milestones"], message: `Weights must add up to 100 (now ${weight})` });
  });

type Reply = CopsCapturingReply;

/**
 * COPS-07 admin operations: module flags, catalogs for the rep-facing dialogs, activation
 * definitions, data inventory, retention runs and operational metrics.
 * Contract: docs/api/copos-07-admin.openapi.yaml.
 */
export async function copsAdminOpsRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;
  const perms = (ws: string, user: string) => getMemberPermissions(db, ws, user);
  const readGate = requireAnyCopsPermission(["admin:read", "admin:admin"], perms);
  const adminGate = requireAnyCopsPermission(["admin:admin"], perms);
  // The catalogs feed the provision and credit dialogs, so the roles that use those dialogs read them.
  const catalogGate = requireAnyCopsPermission(["onboarding:send", "commercial:send", "crm:write", "credits:adjust", "credits:read", "admin:read", "admin:admin"], perms);
  const idempotency = copsIdempotencyStore(db);

  const ctxOf = (request: { workspaceId?: string; userId?: string; headers: Record<string, unknown> }) => ({
    workspaceId: request.workspaceId!,
    userId: request.userId!,
    requestId: resolveCorrelationId(request.headers["x-request-id"] as string | undefined),
  });
  const invalid = (reply: Reply, requestId: string, error: z.ZodError) => {
    const fields = error.issues.map((i) => ({ path: i.path.join(".") || "body", code: i.code, message: i.message }));
    return reply
      .status(copsErrorStatus("VALIDATION_FAILED"))
      .send(copsErrorBody({ code: "VALIDATION_FAILED", message: fields[0]?.message ?? "Invalid request", requestId, details: { fields } }));
  };

  /** Which modules are on. Any signed-in member may read it: the navigation hides what is off. */
  app.get("/cops/modules", async (request, reply) => {
    if (!request.workspaceId) return reply.status(401).send(copsErrorBody({ code: "UNAUTHENTICATED", message: "Missing workspace context", requestId: ctxOf(request).requestId }));
    return { data: await loadCopsModules(db, request.workspaceId) };
  });

  app.get("/trial-templates", { preHandler: catalogGate }, async (request) => ({
    data: (await listConfig(db, request.workspaceId!, "trial_template")).map((c) => ({ key: c.key, version: c.version, ...(c.value as object) })),
  }));

  app.get("/credit-packages", { preHandler: catalogGate }, async (request) => ({
    data: (await listConfig(db, request.workspaceId!, "credit_package"))
      .map((c) => ({ key: c.key, version: c.version, ...(c.value as { active?: boolean }) }))
      .filter((p) => p.active !== false),
  }));

  /** Activation definitions: the newest version per key and segment, workspace versions over system ones. */
  app.get("/admin/activation-templates", { preHandler: readGate }, async (request) => {
    const rows = await db
      .select()
      .from(copsActivationTemplates)
      .where(or(eq(copsActivationTemplates.workspaceId, request.workspaceId!), isNull(copsActivationTemplates.workspaceId)))
      .orderBy(copsActivationTemplates.key, desc(copsActivationTemplates.version));
    return {
      data: rows.map((r) => ({
        id: r.id,
        key: r.key,
        version: r.version,
        segment: r.segment,
        milestones: r.milestones,
        is_system_default: r.workspaceId === null,
        created_at: r.createdAt.toISOString(),
      })),
    };
  });

  /** A change to an activation definition is a new version; accounts already onboarding keep theirs. */
  app.post<{ Params: { key: string }; Body: unknown }>(
    "/admin/activation-templates/:key/versions",
    { preHandler: adminGate },
    withCopsIdempotentReply<{ Params: { key: string }; Body: unknown }>(idempotency, async (request, reply) => {
      const ctx = ctxOf(request);
      const parsed = activationVersionSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
      const key = request.params.key;
      if (!/^[a-z0-9_]{1,64}$/.test(key)) {
        return reply.status(422).send(copsErrorBody({ code: "VALIDATION_FAILED", message: "Invalid template key", requestId: ctx.requestId, details: { fields: [{ path: "key", message: "Invalid template key" }] } }));
      }
      const segment = parsed.data.segment ?? null;
      const created = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${ctx.workspaceId}:activation:${key}:${segment ?? ""}`}))`);
        // Versions continue from the highest one visible to the workspace, system default included.
        const [latest] = await tx
          .select({ version: copsActivationTemplates.version })
          .from(copsActivationTemplates)
          .where(
            and(
              eq(copsActivationTemplates.key, key),
              segment === null ? isNull(copsActivationTemplates.segment) : eq(copsActivationTemplates.segment, segment),
              or(eq(copsActivationTemplates.workspaceId, ctx.workspaceId), isNull(copsActivationTemplates.workspaceId))
            )
          )
          .orderBy(desc(copsActivationTemplates.version))
          .limit(1);
        const [row] = await tx
          .insert(copsActivationTemplates)
          .values({ workspaceId: ctx.workspaceId, key, segment, version: (latest?.version ?? 0) + 1, milestones: parsed.data.milestones })
          .returning();
        await writeCopsAudit(tx, {
          tenantId: ctx.workspaceId,
          actor: { type: "user", id: ctx.userId },
          entityType: "cops_activation_template",
          entityId: row!.id,
          action: "activation_template.version_created",
          before: latest ? { version: latest.version } : null,
          after: { key, segment, version: row!.version },
          reason: parsed.data.reason,
          correlationId: ctx.requestId,
          sourceChannel: "api",
        });
        return row!;
      });
      return reply.status(201).send({ data: { id: created.id, key: created.key, version: created.version, segment: created.segment, milestones: created.milestones } });
    })
  );

  app.get("/admin/data-inventory", { preHandler: readGate }, async () => ({ data: await loadDataInventory(db) }));

  app.get("/admin/retention/runs", { preHandler: readGate }, async (request) => ({
    data: await listRetentionRuns(db, request.workspaceId!),
    targets: RETENTION_TARGETS.map((t) => ({ table: t.table, category: t.category })),
  }));

  app.post<{ Body: unknown }>(
    "/admin/retention/runs",
    { preHandler: adminGate },
    withCopsIdempotentReply<{ Body: unknown }>(idempotency, async (request, reply) => {
      const ctx = ctxOf(request);
      const parsed = retentionRunSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
      try {
        return reply.status(201).send({ data: await startRetentionRun(db, ctx, parsed.data) });
      } catch (error) {
        if (error instanceof RetentionError) {
          return reply.status(error.status).send(copsErrorBody({ code: error.code, message: error.message, requestId: ctx.requestId, details: error.details }));
        }
        throw error;
      }
    })
  );

  app.get("/admin/ops/metrics", { preHandler: readGate }, async (request) => ({ data: await loadOpsMetrics(db, request.workspaceId!) }));
}
