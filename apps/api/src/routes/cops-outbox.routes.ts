import type { FastifyInstance } from "fastify";
import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import { schema, type Db } from "@skout/db";
import {
  buildCopsReplayPlan,
  COPS_REPLAY_MAX_EVENTS,
  copsErrorBody,
  copsErrorStatus,
  resolveCorrelationId,
} from "@skout/shared";
import { getMemberPermissions } from "@skout/auth";
import { requireWorkspaceId } from "../utils/http.js";
import { copsIdempotencyStore, requireCopsPermission, writeCopsAudit } from "../services/cops-platform.service.js";
import { withCopsIdempotency } from "../services/cops-idempotent.js";

const { copsOutbox } = schema;

export const COPS_REPLAY_BODY_SCHEMA = z.object({
  event_ids: z.array(z.string().uuid()).min(1).max(COPS_REPLAY_MAX_EVENTS).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  reason: z.string().trim().min(8).max(500),
}).strict().superRefine((body, ctx) => {
  const hasIds = Boolean(body.event_ids?.length);
  const hasRange = Boolean(body.from || body.to);
  if (hasIds === hasRange) {
    ctx.addIssue({
      code: "custom",
      path: ["event_ids"],
      message: "Provide either event_ids or a complete from/to range",
    });
  }
  if (hasRange && (!body.from || !body.to)) {
    ctx.addIssue({ code: "custom", path: ["from"], message: "A time range requires both from and to" });
  }
  if (body.from && body.to && new Date(body.from) >= new Date(body.to)) {
    ctx.addIssue({ code: "custom", path: ["from"], message: "from must be before to" });
  }
});

export async function copsOutboxRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;
  const gate = requireCopsPermission("admin", "admin", (workspaceId, userId) =>
    getMemberPermissions(db, workspaceId, userId)
  );
  const idempotency = copsIdempotencyStore(db);

  app.post("/cops/events/replay", { preHandler: gate }, withCopsIdempotency(idempotency, async (request) => {
    const requestId = resolveCorrelationId(request.headers["x-request-id"]);
    const parsed = COPS_REPLAY_BODY_SCHEMA.safeParse(request.body);
    if (!parsed.success) {
      return {
        status: copsErrorStatus("VALIDATION_FAILED"),
        body: copsErrorBody({
          code: "VALIDATION_FAILED",
          message: "Invalid replay request",
          requestId,
          details: {
            fields: parsed.error.issues.map((issue) => ({
              path: issue.path.join("."),
              code: issue.code,
              message: issue.message,
            })),
          },
        }),
      };
    }

    const workspaceId = requireWorkspaceId(request);
    const plan = buildCopsReplayPlan({
      tenantId: workspaceId,
      eventIds: parsed.data.event_ids,
      from: parsed.data.from ? new Date(parsed.data.from) : undefined,
      to: parsed.data.to ? new Date(parsed.data.to) : undefined,
    });
    const rangeConditions = [
      eq(copsOutbox.tenantId, workspaceId),
      ...(plan.kind === "ids"
        ? [inArray(copsOutbox.id, plan.eventIds)]
        : [gte(copsOutbox.createdAt, plan.from), lt(copsOutbox.createdAt, plan.to)]),
    ];
    const selected = await db
      .select({
        id: copsOutbox.id,
        eventType: copsOutbox.eventType,
        attempts: copsOutbox.attempts,
        publishedAt: copsOutbox.publishedAt,
        deadLetteredAt: copsOutbox.deadLetteredAt,
      })
      .from(copsOutbox)
      .where(and(...rangeConditions))
      .orderBy(asc(copsOutbox.createdAt))
      .limit(plan.kind === "range" ? plan.limit + 1 : plan.eventIds.length);
    const replayRows = selected.slice(0, plan.kind === "range" ? plan.limit : undefined);
    const now = new Date();

    await db.transaction(async (tx) => {
      if (replayRows.length === 0) return;
      const ids = replayRows.map((row) => row.id);
      await tx
        .update(copsOutbox)
        .set({
          attempts: 0,
          nextAttemptAt: now,
          lastError: null,
          publishedAt: null,
          deadLetteredAt: null,
        })
        .where(and(eq(copsOutbox.tenantId, workspaceId), inArray(copsOutbox.id, ids)));

      for (const row of replayRows) {
        await writeCopsAudit(tx, {
          tenantId: workspaceId,
          actor: { type: "user", id: request.userId ?? null },
          entityType: "outbox_event",
          entityId: row.id,
          action: "event.replayed",
          before: {
            eventType: row.eventType,
            attempts: row.attempts,
            publishedAt: row.publishedAt?.toISOString() ?? null,
            deadLetteredAt: row.deadLetteredAt?.toISOString() ?? null,
          },
          after: { attempts: 0, publishedAt: null, deadLetteredAt: null },
          reason: parsed.data.reason,
          override: true,
          correlationId: requestId,
          sourceChannel: "api",
          occurredAt: now,
        });
      }
    });

    return {
      status: 200,
      body: {
        data: {
          replayed: replayRows.length,
          truncated: plan.kind === "range" && selected.length > plan.limit,
          event_ids: replayRows.map((row) => row.id),
        },
        request_id: requestId,
      },
    };
  }));
}
