import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  InboxService,
  listInboxes,
  getInboxById,
  updateInbox,
  pauseInbox,
  resumeInbox,
  deleteInbox,
  listThreads,
  listDomains,
} from "../services/inbox.service.js";
import { recordBounce, recordSpam } from "../services/inbox-rotation.service.js";

const createInboxBody = z.object({
  emailAddress: z.string().email(),
  displayName: z.string().max(255).optional(),
  provider: z.enum(["smtp", "google", "microsoft"]).default("smtp"),
  dailySendLimit: z.number().int().positive().default(50),
  sendingDomainId: z.string().uuid().optional(),
  smtpHost: z.string().optional(),
  smtpPort: z.number().int().optional(),
  smtpUsername: z.string().optional(),
  smtpPassword: z.string().optional(),
  smtpSecure: z.boolean().default(true),
});

const updateInboxBody = z
  .object({
    displayName: z.string().max(255).optional(),
    dailySendLimit: z.number().int().positive().optional(),
    status: z.enum(["active", "paused", "inactive"]).optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: "At least one field is required",
  });

const resumeBody = z.object({
  resetCounters: z.boolean().default(false),
});

export async function inboxRoutes(app: FastifyInstance) {
  const db = app.db;

  // GET /inboxes
  app.get("/inboxes", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    if (!db) return reply.send({ workspaceId, data: [], total: 0 });
    return reply.send(await listInboxes(db, workspaceId));
  });

  // POST /inboxes
  app.post("/inboxes", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    if (!db) return reply.status(503).send({ error: "database_unavailable" });
    const body = createInboxBody.parse(request.body ?? {});
    const svc = new InboxService(db, app.config);
    const inbox = await svc.createInbox(workspaceId, body);
    return reply.status(201).send(inbox);
  });

  // GET /inboxes/:id
  app.get("/inboxes/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    if (!db) return reply.status(503).send({ error: "database_unavailable" });
    const inbox = await getInboxById(db, workspaceId, id);
    if (!inbox) return reply.status(404).send({ error: "inbox_not_found" });
    return reply.send(inbox);
  });

  // PATCH /inboxes/:id
  app.patch("/inboxes/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    if (!db) return reply.status(503).send({ error: "database_unavailable" });
    const body = updateInboxBody.parse(request.body ?? {});
    const inbox = await updateInbox(db, workspaceId, id, body);
    if (!inbox) return reply.status(404).send({ error: "inbox_not_found" });
    return reply.send(inbox);
  });

  // DELETE /inboxes/:id
  app.delete("/inboxes/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    if (!db) return reply.status(503).send({ error: "database_unavailable" });
    const deleted = await deleteInbox(db, workspaceId, id);
    if (!deleted) return reply.status(404).send({ error: "inbox_not_found" });
    return reply.status(204).send();
  });

  // POST /inboxes/:id/pause
  app.post("/inboxes/:id/pause", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    if (!db) return reply.status(503).send({ error: "database_unavailable" });
    const inbox = await pauseInbox(db, workspaceId, id);
    if (!inbox) return reply.status(404).send({ error: "inbox_not_found" });
    return reply.send(inbox);
  });

  // POST /inboxes/:id/resume
  app.post("/inboxes/:id/resume", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    if (!db) return reply.status(503).send({ error: "database_unavailable" });
    const { resetCounters } = resumeBody.parse(request.body ?? {});
    const inbox = await resumeInbox(db, workspaceId, id, resetCounters);
    if (!inbox) return reply.status(404).send({ error: "inbox_not_found" });
    return reply.send(inbox);
  });

  // POST /inboxes/:id/bounce — webhook: record a bounce event
  app.post("/inboxes/:id/bounce", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    if (!db) return reply.status(503).send({ error: "database_unavailable" });
    const inbox = await getInboxById(db, workspaceId, id);
    if (!inbox) return reply.status(404).send({ error: "inbox_not_found" });
    await recordBounce(db, id, app.config);
    return reply.status(204).send();
  });

  // POST /inboxes/:id/spam — webhook: record a spam complaint
  app.post("/inboxes/:id/spam", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    if (!db) return reply.status(503).send({ error: "database_unavailable" });
    const inbox = await getInboxById(db, workspaceId, id);
    if (!inbox) return reply.status(404).send({ error: "inbox_not_found" });
    await recordSpam(db, id, app.config);
    return reply.status(204).send();
  });

  // GET /domains
  app.get("/domains", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    if (!db) return reply.send({ workspaceId, data: [], total: 0 });
    return reply.send(await listDomains(db, workspaceId));
  });

  // GET /inbox/threads
  app.get("/inbox/threads", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    if (!db) return reply.send({ workspaceId, data: [], total: 0 });
    return reply.send(await listThreads(db, workspaceId));
  });
}
