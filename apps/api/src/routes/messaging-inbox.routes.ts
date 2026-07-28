import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  buildMessagingInboxService,
  type MessagingChannel,
} from "../services/messaging-inbox.service.js";
import { UnipileError } from "../services/unipile.client.js";
import { HttpError } from "../utils/http.js";

const channelSchema = z.enum(["linkedin", "whatsapp"]);

function sendErr(reply: { status: (code: number) => { send: (body: unknown) => unknown } }, err: unknown) {
  const status =
    err instanceof HttpError ? err.statusCode : err instanceof UnipileError ? err.status : 500;
  const message =
    err instanceof HttpError
      ? err.message
      : err instanceof UnipileError
        ? err.message
        : "messaging_inbox_error";
  return reply.status(status >= 400 && status < 600 ? status : 500).send({ error: message });
}

function parseChannel(raw: string): MessagingChannel {
  return channelSchema.parse(raw);
}

export async function messagingInboxRoutes(app: FastifyInstance) {
  app.get("/messaging/:channel/accounts", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const { channel: channelRaw } = request.params as { channel: string };
    const svc = buildMessagingInboxService(app.db, app.config);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    try {
      const channel = parseChannel(channelRaw);
      const data = await svc.listAccounts(workspaceId, channel);
      return reply.send({ workspaceId, channel, data, total: data.length });
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.get("/messaging/:channel/chats", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const { channel: channelRaw } = request.params as { channel: string };
    const svc = buildMessagingInboxService(app.db, app.config);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const query = z
      .object({
        accountId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      })
      .parse(request.query ?? {});
    try {
      const channel = parseChannel(channelRaw);
      const result = await svc.listChats(workspaceId, channel, query.accountId, query.limit ?? 50);
      return reply.send(result);
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.get("/messaging/:channel/chats/:threadId/messages", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const { threadId } = request.params as { channel: string; threadId: string };
    const svc = buildMessagingInboxService(app.db, app.config);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(100).optional() })
      .parse(request.query ?? {});
    try {
      const result = await svc.listMessages(
        workspaceId,
        decodeURIComponent(threadId),
        query.limit ?? 50
      );
      return reply.send(result);
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.post("/messaging/:channel/chats/:threadId/reply", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const { threadId } = request.params as { channel: string; threadId: string };
    const svc = buildMessagingInboxService(app.db, app.config);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const body = z.object({ text: z.string().min(1).max(8000) }).parse(request.body ?? {});
    try {
      const message = await svc.reply(workspaceId, decodeURIComponent(threadId), body.text);
      return reply.status(201).send(message);
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.post("/messaging/:channel/chats/:threadId/read", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const { threadId } = request.params as { channel: string; threadId: string };
    const svc = buildMessagingInboxService(app.db, app.config);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    try {
      const result = await svc.markRead(workspaceId, decodeURIComponent(threadId));
      return reply.send(result);
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.get("/messaging/:channel/chats/:threadId/context", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const { threadId } = request.params as { channel: string; threadId: string };
    const svc = buildMessagingInboxService(app.db, app.config);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    try {
      const result = await svc.getContext(workspaceId, decodeURIComponent(threadId));
      return reply.send(result);
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  // LinkedIn-only people search / outreach
  app.get("/messaging/linkedin/people", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildMessagingInboxService(app.db, app.config);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const query = z
      .object({
        accountId: z.string().uuid().optional(),
        mode: z.enum(["connections", "search"]).default("connections"),
        q: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(50).optional(),
        cursor: z.string().optional(),
      })
      .parse(request.query ?? {});
    try {
      const result = await svc.searchPeople(workspaceId, {
        accountId: query.accountId,
        mode: query.mode,
        query: query.q ?? "",
        limit: query.limit,
        cursor: query.cursor,
      });
      return reply.send(result);
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.post("/messaging/linkedin/outreach", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildMessagingInboxService(app.db, app.config);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const body = z
      .object({
        accountId: z.string().uuid().optional(),
        action: z.enum(["connect", "message"]),
        providerId: z.string().min(1).max(200),
        text: z.string().max(8000).optional(),
      })
      .parse(request.body ?? {});
    try {
      if (body.action === "connect") {
        const result = await svc.sendConnectionRequest(workspaceId, {
          accountId: body.accountId,
          providerId: body.providerId,
          message: body.text,
        });
        return reply.status(201).send(result);
      }
      const result = await svc.sendDirectMessage(workspaceId, {
        accountId: body.accountId,
        providerId: body.providerId,
        text: body.text ?? "",
      });
      return reply.status(201).send(result);
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.post("/messaging/whatsapp/outreach", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildMessagingInboxService(app.db, app.config);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const body = z
      .object({
        accountId: z.string().uuid().optional(),
        phone: z.string().min(8).max(32),
        text: z.string().min(1).max(8000),
      })
      .parse(request.body ?? {});
    try {
      const result = await svc.sendWhatsappMessage(workspaceId, body);
      return reply.status(201).send(result);
    } catch (err) {
      return sendErr(reply, err);
    }
  });
}
