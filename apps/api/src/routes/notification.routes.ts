import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getMemberPermissions } from "@skout/auth";
import { schema } from "@skout/db";
import {
  COPS_PHASE1_EVENTS,
  copsErrorBody,
  copsErrorStatus,
  resolveCorrelationId,
  type CopsPhase1EventType,
} from "@skout/shared";
import { errorResponse, HttpError } from "../utils/http.js";
import {
  COPS_NOTIFICATION_ROLE_KEYS,
  type CopsNotificationRoleKey,
} from "../services/cops-notification-routing.js";
import { requireCopsPermission, writeCopsAudit } from "../services/cops-platform.service.js";
import {
  createNotification,
  listNotifications,
  listPreferences,
  markAllRead,
  markRead,
  setPreference,
  unreadCount,
  type NotificationChannel,
} from "../services/notifications.service.js";

const VALID_CHANNELS: NotificationChannel[] = ["in_app", "email", "both", "sms"];
const { copsNotificationRoutes } = schema;
const COPS_EVENT_TYPES = Object.keys(COPS_PHASE1_EVENTS);
const copsRouteBodySchema = z.object({
  event_type: z.string().refine((value) => COPS_EVENT_TYPES.includes(value), "Unknown COPS event type"),
  role_keys: z.array(z.enum(COPS_NOTIFICATION_ROLE_KEYS)).max(COPS_NOTIFICATION_ROLE_KEYS.length),
  reason: z.string().trim().min(8).max(500),
}).strict();
const copsRouteResetSchema = z.object({
  params: z.object({
    eventType: z.string().refine((value) => COPS_EVENT_TYPES.includes(value), "Unknown COPS event type"),
  }).strict(),
  body: z.object({ reason: z.string().trim().min(8).max(500) }).strict(),
});

function sendInvalidCopsRoute(reply: FastifyReply, requestId: string, error: z.ZodError) {
  return reply.status(copsErrorStatus("VALIDATION_FAILED")).send(
    copsErrorBody({
      code: "VALIDATION_FAILED",
      message: "Invalid COPS notification route",
      requestId,
      details: {
        fields: error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
          message: issue.message,
        })),
      },
    })
  );
}

/** R17.1 — notification center + R17.4 — email/Slack delivery channel preferences. */
export async function notificationRoutes(app: FastifyInstance) {
  function db() {
    if (!app.db) throw new HttpError("Database not available", 500);
    return app.db;
  }

  const copsAdminGate = async (request: FastifyRequest, reply: FastifyReply) => {
    const database = app.db;
    if (!database) return reply.code(503).send(errorResponse("Database unavailable", 503));
    return requireCopsPermission("admin", "admin", (workspaceId, userId) =>
      getMemberPermissions(database, workspaceId, userId)
    )(request, reply);
  };

  // COPS event routing configuration is part of the existing notification API and admin surface.
  app.get("/notifications/cops-routes", { preHandler: copsAdminGate }, async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const rows = await db()
      .select({
        eventType: copsNotificationRoutes.eventType,
        roleKeys: copsNotificationRoutes.roleKeys,
        updatedAt: copsNotificationRoutes.updatedAt,
      })
      .from(copsNotificationRoutes)
      .where(eq(copsNotificationRoutes.workspaceId, request.workspaceId));
    return reply.send({ data: rows });
  });

  app.put("/notifications/cops-routes", { preHandler: copsAdminGate }, async (request, reply) => {
    const requestId = resolveCorrelationId(request.headers["x-request-id"]);
    const parsed = copsRouteBodySchema.safeParse(request.body);
    if (!parsed.success) return sendInvalidCopsRoute(reply, requestId, parsed.error);
    if (!request.workspaceId || !request.userId) {
      return reply.code(401).send(errorResponse("Unauthorized", 401));
    }

    const workspaceId = request.workspaceId;
    const userId = request.userId;
    const eventType = parsed.data.event_type as CopsPhase1EventType;
    const roleKeys = parsed.data.role_keys as CopsNotificationRoleKey[];
    const occurredAt = new Date();
    const result = await db().transaction(async (tx) => {
      const [before] = await tx
        .select({ roleKeys: copsNotificationRoutes.roleKeys })
        .from(copsNotificationRoutes)
        .where(
          and(
            eq(copsNotificationRoutes.workspaceId, workspaceId),
            eq(copsNotificationRoutes.eventType, eventType)
          )
        )
        .limit(1);

      const [updated] = await tx
        .insert(copsNotificationRoutes)
        .values({
          workspaceId,
          eventType,
          roleKeys,
          updatedBy: userId,
          updatedAt: occurredAt,
        })
        .onConflictDoUpdate({
          target: [copsNotificationRoutes.workspaceId, copsNotificationRoutes.eventType],
          set: { roleKeys, updatedBy: userId, updatedAt: occurredAt },
        })
        .returning({
          eventType: copsNotificationRoutes.eventType,
          roleKeys: copsNotificationRoutes.roleKeys,
          updatedAt: copsNotificationRoutes.updatedAt,
        });

      await writeCopsAudit(tx, {
        tenantId: workspaceId,
        actor: { type: "user", id: userId },
        entityType: "cops_notification_route",
        entityId: workspaceId,
        action: "notification_route.updated",
        before: { event_type: eventType, role_keys: before?.roleKeys ?? null },
        after: { event_type: eventType, role_keys: roleKeys },
        reason: parsed.data.reason,
        correlationId: requestId,
        sourceChannel: "api",
        occurredAt,
      });
      return updated;
    });
    return reply.send({ data: result, request_id: requestId });
  });

  app.delete<{ Params: { eventType: string } }>(
    "/notifications/cops-routes/:eventType",
    { preHandler: copsAdminGate },
    async (request, reply) => {
      const requestId = resolveCorrelationId(request.headers["x-request-id"]);
      const parsed = copsRouteResetSchema.safeParse({ params: request.params, body: request.body });
      if (!parsed.success) return sendInvalidCopsRoute(reply, requestId, parsed.error);
      if (!request.workspaceId || !request.userId) {
        return reply.code(401).send(errorResponse("Unauthorized", 401));
      }

      const workspaceId = request.workspaceId;
      const userId = request.userId;
      const eventType = parsed.data.params.eventType as CopsPhase1EventType;
      const occurredAt = new Date();
      const reset = await db().transaction(async (tx) => {
        const [before] = await tx
          .select({ roleKeys: copsNotificationRoutes.roleKeys })
          .from(copsNotificationRoutes)
          .where(
            and(
              eq(copsNotificationRoutes.workspaceId, workspaceId),
              eq(copsNotificationRoutes.eventType, eventType)
            )
          )
          .limit(1);

        if (!before) return false;

        await tx
          .delete(copsNotificationRoutes)
          .where(
            and(
              eq(copsNotificationRoutes.workspaceId, workspaceId),
              eq(copsNotificationRoutes.eventType, eventType)
            )
          );
        await writeCopsAudit(tx, {
          tenantId: workspaceId,
          actor: { type: "user", id: userId },
          entityType: "cops_notification_route",
          entityId: workspaceId,
          action: "notification_route.reset",
          before: { event_type: eventType, role_keys: before.roleKeys },
          after: { event_type: eventType, role_keys: null },
          reason: parsed.data.body.reason,
          correlationId: requestId,
          sourceChannel: "api",
          occurredAt,
        });
        return true;
      });
      return reply.send({ data: { eventType, reset }, request_id: requestId });
    }
  );

  // GET /notifications?unread=true&type=activation_rule
  app.get<{ Querystring: { unread?: string; type?: string; limit?: string } }>(
    "/notifications",
    async (request, reply) => {
      if (!request.workspaceId || !request.userId) {
        return reply.code(401).send(errorResponse("Unauthorized", 401));
      }
      const rows = await listNotifications(db(), request.workspaceId, request.userId, {
        unreadOnly: request.query.unread === "true",
        type: request.query.type,
        limit: request.query.limit ? Number(request.query.limit) : undefined,
      });
      return reply.send({ data: rows });
    }
  );

  // GET /notifications/unread-count — cheap poll target for the bell badge
  app.get("/notifications/unread-count", async (request, reply) => {
    if (!request.workspaceId || !request.userId) {
      return reply.code(401).send(errorResponse("Unauthorized", 401));
    }
    const count = await unreadCount(db(), request.workspaceId, request.userId);
    return reply.send({ data: { count } });
  });

  // POST /notifications/:id/read
  app.post<{ Params: { id: string } }>("/notifications/:id/read", async (request, reply) => {
    if (!request.workspaceId || !request.userId) {
      return reply.code(401).send(errorResponse("Unauthorized", 401));
    }
    const ok = await markRead(db(), request.workspaceId, request.userId, request.params.id);
    if (!ok) return reply.code(404).send(errorResponse("Notification not found", 404));
    return reply.send({ data: { read: true } });
  });

  // POST /notifications/read-all
  app.post("/notifications/read-all", async (request, reply) => {
    if (!request.workspaceId || !request.userId) {
      return reply.code(401).send(errorResponse("Unauthorized", 401));
    }
    const count = await markAllRead(db(), request.workspaceId, request.userId);
    return reply.send({ data: { markedRead: count } });
  });

  // GET /notifications/preferences
  app.get("/notifications/preferences", async (request, reply) => {
    if (!request.workspaceId || !request.userId) {
      return reply.code(401).send(errorResponse("Unauthorized", 401));
    }
    const rows = await listPreferences(db(), request.workspaceId, request.userId);
    return reply.send({ data: rows });
  });

  // PUT /notifications/preferences — body: { type, channel: "in_app"|"email"|"both", digest?: boolean }
  // `digest` (R17.3) only takes effect when channel includes email: batches delivery into the
  // daily digest sweep instead of a real-time send for that notification type.
  app.put<{ Body: { type: string; channel: NotificationChannel; digest?: boolean } }>(
    "/notifications/preferences",
    async (request, reply) => {
      if (!request.workspaceId || !request.userId) {
        return reply.code(401).send(errorResponse("Unauthorized", 401));
      }
      const { type, channel, digest } = request.body ?? ({} as { type?: string; channel?: NotificationChannel; digest?: boolean });
      if (!type) return reply.code(400).send(errorResponse("type is required", 400));
      if (!channel || !VALID_CHANNELS.includes(channel)) {
        return reply.code(400).send(errorResponse(`channel must be one of ${VALID_CHANNELS.join(", ")}`, 400));
      }
      const row = await setPreference(db(), request.workspaceId, request.userId, type, channel, digest ?? false);
      return reply.send({ data: row });
    }
  );

  // POST /notifications/test — owner/admin only. Sends yourself a test notification so the
  // feed/channel wiring can be verified before any real trigger (R17.2/R17.3) exists.
  app.post("/notifications/test", async (request, reply) => {
    if (!request.workspaceId || !request.userId || !request.role) {
      return reply.code(401).send(errorResponse("Unauthorized", 401));
    }
    if (!["owner", "admin"].includes(request.role)) {
      return reply.code(403).send(errorResponse("Requires role: owner or admin", 403));
    }
    const row = await createNotification(db(), app.config, {
      workspaceId: request.workspaceId,
      userId: request.userId,
      type: "test",
      title: "Test notification",
      body: "This confirms your notification center and delivery channels are wired up correctly.",
    });
    return reply.code(201).send({ data: row });
  });
}
