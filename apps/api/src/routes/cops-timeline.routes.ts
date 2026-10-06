import type { FastifyInstance } from "fastify";
import { Buffer } from "node:buffer";
import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import { z } from "zod";
import { schema, type Db } from "@skout/db";
import { COPS_TIMELINE_TYPES, copsErrorBody, copsErrorStatus, resolveCorrelationId } from "@skout/shared";
import { getMemberPermissions } from "@skout/auth";
import { requireCopsPermission } from "../services/cops-platform.service.js";

const { copsTimelineEvents } = schema;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIMIT_MAX = 100;

const cursorSchema = z.object({ occurred_at: z.string().datetime(), id: z.string().uuid() });

export function encodeTimelineCursor(occurredAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ occurred_at: occurredAt.toISOString(), id }), "utf8").toString("base64url");
}

export function decodeTimelineCursor(cursor: string): { occurredAt: Date; id: string } | null {
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    return parsed.success ? { occurredAt: new Date(parsed.data.occurred_at), id: parsed.data.id } : null;
  } catch {
    return null;
  }
}

/** GET /api/v1/accounts/:id/timeline — crm:read. Internal notes need crm:admin. Newest first. */
export async function copsTimelineRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;
  const gate = requireCopsPermission("crm", "read", (ws, user) => getMemberPermissions(db, ws, user));

  app.get<{ Params: { id: string } }>("/accounts/:id/timeline", { preHandler: gate }, async (request, reply) => {
    const requestId = resolveCorrelationId(request.headers["x-request-id"]);
    const invalid = (message: string, path: string) =>
      reply.status(copsErrorStatus("VALIDATION_FAILED")).send(
        copsErrorBody({
          code: "VALIDATION_FAILED",
          message,
          requestId,
          details: { fields: [{ path, code: "invalid", message }] },
        })
      );

    if (!UUID.test(request.params.id)) return invalid("Invalid account id", "id");
    const q = request.query as { limit?: string; cursor?: string; type?: string | string[] };
    const limit = Math.min(LIMIT_MAX, Math.max(1, Number.parseInt(q.limit ?? "25", 10) || 25));

    const types = (Array.isArray(q.type) ? q.type : q.type ? q.type.split(",") : []).filter(Boolean);
    if (types.some((t) => !(COPS_TIMELINE_TYPES as readonly string[]).includes(t))) {
      return invalid("Unknown timeline type", "type");
    }

    let cursor: { occurredAt: Date; id: string } | null = null;
    if (q.cursor) {
      cursor = decodeTimelineCursor(q.cursor);
      if (!cursor) return invalid("Invalid cursor", "cursor");
    }

    const workspaceId = request.workspaceId!;
    const permissions = await getMemberPermissions(db, workspaceId, request.userId!);
    const canSeeInternal = permissions.includes("crm:admin");

    const conditions = [
      eq(copsTimelineEvents.workspaceId, workspaceId),
      eq(copsTimelineEvents.accountId, request.params.id),
    ];
    if (!canSeeInternal) conditions.push(eq(copsTimelineEvents.visibility, "public"));
    if (types.length) conditions.push(inArray(copsTimelineEvents.type, types));
    if (cursor) {
      conditions.push(
        or(
          lt(copsTimelineEvents.occurredAt, cursor.occurredAt),
          and(eq(copsTimelineEvents.occurredAt, cursor.occurredAt), lt(copsTimelineEvents.id, cursor.id))
        )!
      );
    }

    const rows = await db
      .select({
        id: copsTimelineEvents.id,
        type: copsTimelineEvents.type,
        visibility: copsTimelineEvents.visibility,
        occurredAt: copsTimelineEvents.occurredAt,
        actorType: copsTimelineEvents.actorType,
        actorId: copsTimelineEvents.actorId,
        sourceEventId: copsTimelineEvents.sourceEventId,
        summary: copsTimelineEvents.summary,
      })
      .from(copsTimelineEvents)
      .where(and(...conditions))
      .orderBy(desc(copsTimelineEvents.occurredAt), desc(copsTimelineEvents.id))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      data: page.map((r) => ({
        id: r.id,
        type: r.type,
        visibility: r.visibility,
        occurred_at: r.occurredAt.toISOString(),
        actor: { type: r.actorType, id: r.actorId },
        source_event_id: r.sourceEventId,
        summary: r.summary,
      })),
      next_cursor: rows.length > limit && last ? encodeTimelineCursor(last.occurredAt, last.id) : null,
    };
  });
}
