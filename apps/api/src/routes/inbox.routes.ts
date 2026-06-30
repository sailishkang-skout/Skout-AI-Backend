import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { buildInboxService } from "../services/inbox.service.js";
import { HttpError } from "../utils/http.js";

const createInboxSchema = z.object({
  emailAddress: z.string().email(),
  displayName: z.string().max(255).optional(),
  smtpHost: z.string().min(1),
  smtpPort: z.number().int().positive(),
  smtpUsername: z.string().min(1),
  smtpPassword: z.string().min(1),
  smtpSecure: z.boolean().optional(),
  dailySendLimit: z.number().int().positive().optional(),
});

export async function inboxRoutes(app: FastifyInstance) {
  app.get("/inboxes", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildInboxService(app.db, app.config);
    if (!svc) return reply.send({ workspaceId, data: [], total: 0 });
    return reply.send(await svc.listInboxes(workspaceId));
  });

  app.post("/inboxes", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildInboxService(app.db, app.config);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const body = createInboxSchema.parse(request.body ?? {});
    try {
      const inbox = await svc.createInbox(workspaceId, body);
      return reply.status(201).send(inbox);
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send({ error: err.message, details: err.details ?? null });
      }
      throw err;
    }
  });

  app.get("/domains", async (_request, reply) => {
    return reply.send({ data: [], total: 0 });
  });

  app.get("/inbox/threads", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildInboxService(app.db, app.config);
    if (!svc) return reply.send({ workspaceId, data: [], total: 0 });
    return reply.send(await svc.listThreads(workspaceId));
  });
}
