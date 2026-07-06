import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { schema } from "@skout/db";
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
  buildInboxService,
} from "../services/inbox.service.js";
import type { ThreadStatus } from "../services/inbox.service.js";
import { recordBounce, recordSpam } from "../services/inbox-rotation.service.js";
import { ingestInboundMessage } from "../services/inbound-reply.service.js";
import { HttpError } from "../utils/http.js";

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
  imapHost: z.string().optional(),
  imapPort: z.number().int().optional(),
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

const inboundWebhookSchema = z.object({
  inboxEmailAddress: z.string().email(),
  from: z.string().email(),
  to: z.string().email(),
  subject: z.string().optional(),
  bodyText: z.string().optional(),
  bodyHtml: z.string().optional(),
  messageId: z.string().optional(),
  inReplyTo: z.string().optional(),
  references: z.string().optional(),
  sentAt: z.string().datetime().optional(),
  rawHeaders: z.record(z.string()).optional(),
});

const THREAD_STATUSES = ["new", "replied", "bounced", "meeting_booked", "closed"] as const;

const threadStatusTransitionSchema = z.object({
  status: z.enum(THREAD_STATUSES),
});

const replySchema = z.object({
  text: z.string().min(1),
  html: z.string().optional(),
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

  // POST /inboxes/:id/bounce
  app.post("/inboxes/:id/bounce", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    if (!db) return reply.status(503).send({ error: "database_unavailable" });
    const inbox = await getInboxById(db, workspaceId, id);
    if (!inbox) return reply.status(404).send({ error: "inbox_not_found" });
    await recordBounce(db, id, app.config);
    return reply.status(204).send();
  });

  // POST /inboxes/:id/spam
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

  // GET /inbox/threads/:threadId
  app.get("/inbox/threads/:threadId", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const { threadId } = request.params as { threadId: string };
    const svc = buildInboxService(db, app.config);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    try {
      return reply.send(await svc.getThread(workspaceId, threadId));
    } catch (err) {
      if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  // GET /inbox/threads/:threadId/messages
  app.get("/inbox/threads/:threadId/messages", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const { threadId } = request.params as { threadId: string };
    const { limit, offset } = request.query as { limit?: string; offset?: string };
    const svc = buildInboxService(db, app.config);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    try {
      return reply.send(
        await svc.listMessages(workspaceId, threadId, {
          limit: limit ? parseInt(limit, 10) : undefined,
          offset: offset ? parseInt(offset, 10) : undefined,
        })
      );
    } catch (err) {
      if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  // GET /inbox/threads/:threadId/context
  app.get("/inbox/threads/:threadId/context", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const { threadId } = request.params as { threadId: string };
    const svc = buildInboxService(db, app.config);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    try {
      return reply.send(await svc.getThreadContext(workspaceId, threadId));
    } catch (err) {
      if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  // PATCH /inbox/threads/:threadId/status
  app.patch("/inbox/threads/:threadId/status", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const { threadId } = request.params as { threadId: string };
    const svc = buildInboxService(db, app.config);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    try {
      const { status } = threadStatusTransitionSchema.parse(request.body ?? {});
      return reply.send(await svc.transitionThreadStatus(workspaceId, threadId, status as ThreadStatus));
    } catch (err) {
      if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  // POST /inbox/threads/:threadId/reply
  app.post("/inbox/threads/:threadId/reply", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const { threadId } = request.params as { threadId: string };
    const svc = buildInboxService(db, app.config);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    try {
      const body = replySchema.parse(request.body ?? {});
      const message = await svc.replyToThread(workspaceId, threadId, body);
      return reply.status(201).send(message);
    } catch (err) {
      if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  // POST /inbox/webhooks/inbound
  app.post("/inbox/webhooks/inbound", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    if (!db) return reply.status(503).send({ error: "database_unavailable" });

    const body = inboundWebhookSchema.parse(request.body ?? {});

    const [inboxRow] = await db
      .select({ id: schema.inboxes.id })
      .from(schema.inboxes)
      .where(
        and(
          eq(schema.inboxes.workspaceId, workspaceId),
          eq(schema.inboxes.emailAddress, body.inboxEmailAddress)
        )
      )
      .limit(1);

    if (!inboxRow) return reply.status(404).send({ error: "inbox_not_found" });

    await ingestInboundMessage(db as any, workspaceId, inboxRow.id, {
      fromAddress: body.from,
      toAddress: body.to,
      subject: body.subject,
      bodyText: body.bodyText,
      bodyHtml: body.bodyHtml,
      messageId: body.messageId,
      inReplyTo: body.inReplyTo,
      references: body.references,
      sentAt: body.sentAt ? new Date(body.sentAt) : new Date(),
      rawHeaders: body.rawHeaders,
    });

    return reply.status(202).send({ ok: true });
  });
}
