import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  getUnreadCount,
  listNotifications,
  markAllRead,
  markRead,
} from "../services/notification.service.js";
import { errorResponse } from "../utils/http.js";

const listQuerySchema = z.object({
  unreadOnly: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  type: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** In-app notification center (R17.1) — the store every alert type plugs into. */
export async function notificationRoutes(app: FastifyInstance) {
  app.get("/notifications", async (request, reply) => {
    const workspaceId = request.workspaceId;
    const userId = request.userId;
    if (!workspaceId || !userId) return reply.status(401).send(errorResponse("Not authenticated", 401));
    if (!app.db) return reply.send({ data: [], total: 0 });

    const { unreadOnly, type, limit } = listQuerySchema.parse(request.query ?? {});
    const data = await listNotifications(app.db, workspaceId, userId, { unreadOnly, type, limit });
    return reply.send({ data, total: data.length });
  });

  app.get("/notifications/unread-count", async (request, reply) => {
    const workspaceId = request.workspaceId;
    const userId = request.userId;
    if (!workspaceId || !userId) return reply.status(401).send(errorResponse("Not authenticated", 401));
    if (!app.db) return reply.send({ count: 0 });

    const count = await getUnreadCount(app.db, workspaceId, userId);
    return reply.send({ count });
  });

  app.post("/notifications/:id/read", async (request, reply) => {
    const workspaceId = request.workspaceId;
    const userId = request.userId;
    if (!workspaceId || !userId) return reply.status(401).send(errorResponse("Not authenticated", 401));
    if (!app.db) return reply.status(503).send(errorResponse("Database unavailable", 503));

    const { id } = request.params as { id: string };
    const updated = await markRead(app.db, workspaceId, userId, id);
    if (!updated) return reply.status(404).send(errorResponse("notification_not_found", 404));
    return reply.send(updated);
  });

  app.post("/notifications/mark-all-read", async (request, reply) => {
    const workspaceId = request.workspaceId;
    const userId = request.userId;
    if (!workspaceId || !userId) return reply.status(401).send(errorResponse("Not authenticated", 401));
    if (!app.db) return reply.send({ marked: 0 });

    const marked = await markAllRead(app.db, workspaceId, userId);
    return reply.send({ marked });
  });
}
