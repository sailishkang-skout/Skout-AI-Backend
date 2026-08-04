import type { FastifyInstance } from "fastify";
import { errorResponse, HttpError } from "../utils/http.js";
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

const VALID_CHANNELS: NotificationChannel[] = ["in_app", "email", "both"];

/** R17.1 — notification center + R17.4 — email/Slack delivery channel preferences. */
export async function notificationRoutes(app: FastifyInstance) {
  function db() {
    if (!app.db) throw new HttpError("Database not available", 500);
    return app.db;
  }

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

  // PUT /notifications/preferences — body: { type: string, channel: "in_app"|"email"|"both" }
  app.put<{ Body: { type: string; channel: NotificationChannel } }>(
    "/notifications/preferences",
    async (request, reply) => {
      if (!request.workspaceId || !request.userId) {
        return reply.code(401).send(errorResponse("Unauthorized", 401));
      }
      const { type, channel } = request.body ?? ({} as { type?: string; channel?: NotificationChannel });
      if (!type) return reply.code(400).send(errorResponse("type is required", 400));
      if (!channel || !VALID_CHANNELS.includes(channel)) {
        return reply.code(400).send(errorResponse(`channel must be one of ${VALID_CHANNELS.join(", ")}`, 400));
      }
      const row = await setPreference(db(), request.workspaceId, request.userId, type, channel);
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
