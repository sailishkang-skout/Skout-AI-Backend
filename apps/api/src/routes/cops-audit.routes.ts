import type { FastifyInstance } from "fastify";
import { Buffer } from "node:buffer";
import { and, desc, eq, gte, ilike, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { schema, type Db } from "@skout/db";
import { copsErrorBody, copsErrorStatus, resolveCorrelationId } from "@skout/shared";
import { getMemberPermissions } from "@skout/auth";
import { requireWorkspaceId } from "../utils/http.js";
import { requireCopsPermission } from "../services/cops-platform.service.js";

const { auditLogs, users } = schema;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const cursorPayloadSchema = z.object({ created_at: z.string().datetime(), id: z.string().uuid() });

export const COPS_AUDIT_MAX_LIMIT = 100;

export function decodeCopsAuditCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const payload = cursorPayloadSchema.safeParse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    if (!payload.success) return null;
    return { createdAt: new Date(payload.data.created_at), id: payload.data.id };
  } catch {
    return null;
  }
}

const querySchema = z.object({
  search: z.string().trim().min(1).max(120).optional(),
  actor_id: z.string().min(1).optional(),
  entity_type: z.string().min(1).optional(),
  entity_id: z.string().min(1).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(COPS_AUDIT_MAX_LIMIT).default(25),
}).superRefine((query, ctx) => {
  if (query.from && query.to && new Date(query.from) > new Date(query.to)) {
    ctx.addIssue({ code: "custom", path: ["from"], message: "from must be before or equal to to" });
  }
  if (query.entity_id && !UUID.test(query.entity_id)) {
    ctx.addIssue({ code: "custom", path: ["entity_id"], message: "entity_id must be a UUID" });
  }
  if (query.cursor && !decodeCopsAuditCursor(query.cursor)) {
    ctx.addIssue({ code: "custom", path: ["cursor"], message: "cursor is invalid" });
  }
});

export type CopsAuditQuery = z.infer<typeof querySchema>;

/**
 * Builds the WHERE conditions for an audit read. The tenant condition is always first, so a caller
 * can never read another workspace's rows even if filters are omitted.
 */
export function copsAuditConditions(tenantId: string, q: CopsAuditQuery): SQL[] {
  const conds: SQL[] = [eq(auditLogs.workspaceId, tenantId)];
  if (q.search) {
    const pattern = `%${q.search}%`;
    conds.push(
      or(
        ilike(users.email, pattern),
        ilike(users.fullName, pattern),
        ilike(auditLogs.actorRef, pattern),
        ilike(auditLogs.action, pattern),
        ilike(auditLogs.entityType, pattern),
        sql`${auditLogs.entityId}::text ILIKE ${pattern}`,
        ilike(auditLogs.reason, pattern)
      )!
    );
  }
  if (q.actor_id) {
    const actorMatches = [eq(auditLogs.actorRef, q.actor_id)];
    if (UUID.test(q.actor_id)) actorMatches.push(eq(auditLogs.actorId, q.actor_id));
    conds.push(or(...actorMatches)!);
  }
  if (q.entity_type) conds.push(eq(auditLogs.entityType, q.entity_type));
  if (q.entity_id) conds.push(eq(auditLogs.entityId, q.entity_id));
  if (q.from) conds.push(gte(auditLogs.createdAt, new Date(q.from)));
  if (q.to) conds.push(lte(auditLogs.createdAt, new Date(q.to)));
  if (q.cursor) {
    const cursor = decodeCopsAuditCursor(q.cursor);
    if (!cursor) throw new Error("Invalid audit cursor");
    conds.push(
      or(
        lt(auditLogs.createdAt, cursor.createdAt),
        and(eq(auditLogs.createdAt, cursor.createdAt), lt(auditLogs.id, cursor.id))
      )!
    );
  }
  return conds;
}

/** GET /api/v1/cops/audit — admin:read. Newest first, keyset-paginated by occurred_at and id. */
export async function copsAuditRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;
  const gate = requireCopsPermission("admin", "read", (ws, user) => getMemberPermissions(db, ws, user));

  app.get("/cops/audit", { preHandler: gate }, async (request, reply) => {
    const requestId = resolveCorrelationId(request.headers["x-request-id"]);
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(copsErrorStatus("VALIDATION_FAILED")).send(
        copsErrorBody({
          code: "VALIDATION_FAILED",
          message: "Invalid query",
          requestId,
          details: {
            fields: parsed.error.issues.map((i) => ({
              path: i.path.join("."),
              code: i.code,
              message: i.message,
            })),
          },
        })
      );
    }
    const q = parsed.data;
    const workspaceId = requireWorkspaceId(request);
    const rows = await db
      .select({
        auditLog: auditLogs,
        actorName: users.fullName,
        actorEmail: users.email,
      })
      .from(auditLogs)
      .leftJoin(users, eq(auditLogs.actorId, users.id))
      .where(and(...copsAuditConditions(workspaceId, q)))
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(q.limit + 1);

    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1]?.auditLog;
    return {
      data: page.map(({ auditLog: row, actorName, actorEmail }) => ({
        ...row,
        tenantId: row.workspaceId,
        actorId: row.actorRef ?? row.actorId,
        actorName,
        actorEmail,
        occurredAt: row.createdAt,
        sourceChannel: row.sourceChannel ?? "legacy",
      })),
      next_cursor:
        rows.length > q.limit && last
          ? Buffer.from(JSON.stringify({ created_at: last.createdAt.toISOString(), id: last.id })).toString("base64url")
          : null,
    };
  });
}
