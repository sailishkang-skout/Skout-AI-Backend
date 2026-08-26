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
  listDomains,
  addDomain,
  removeDomain,
  getDomainDns,
  verifyDomain,
  getDeliverabilityMetrics,
  buildInboxService,
} from "../services/inbox.service.js";
import type { ThreadStatus } from "../services/inbox.service.js";
import { recordBounce, recordSpam } from "../services/inbox-rotation.service.js";
import { ingestInboundMessage } from "../services/inbound-reply.service.js";
import { SuggestReplyService } from "../services/suggest-reply.service.js";
import {
  getGoogleConnectUrl,
  handleGoogleCallback,
  getMicrosoftConnectUrl,
  handleMicrosoftCallback,
} from "../services/inbox-oauth.service.js";
import { HttpError } from "../utils/http.js";

const PROVIDER_ALIASES: Record<string, "smtp" | "google" | "microsoft"> = {
  google: "google",
  gmail: "google",
  "gmail / google workspace": "google",
  "google workspace": "google",
  microsoft: "microsoft",
  outlook: "microsoft",
  "outlook / office 365": "microsoft",
  "office 365": "microsoft",
  smtp: "smtp",
};

// Coerce empty strings to undefined so optional fields aren't stored as ""
function emptyToUndefined(v: unknown) {
  return v === "" ? undefined : v;
}

const createInboxBody = z.preprocess(
  (raw: unknown) => {
    if (typeof raw !== "object" || raw === null) return raw;
    const r = raw as Record<string, unknown>;
    return {
      ...r,
      // Normalise email field name (frontend may send email, emailAddress, or email_address)
      emailAddress: r.emailAddress ?? r.email ?? r.email_address,
      // Normalise provider display names → internal enum values
      provider:
        typeof r.provider === "string"
          ? (PROVIDER_ALIASES[r.provider.toLowerCase()] ?? r.provider)
          : r.provider,
      // Normalise SMTP field names (frontend sends smtpUser / smtpPass)
      smtpUsername: emptyToUndefined(r.smtpUsername ?? r.smtpUser),
      smtpPassword: emptyToUndefined(r.smtpPassword ?? r.smtpPass),
      smtpHost: emptyToUndefined(r.smtpHost),
    };
  },
  z.object({
    emailAddress: z.string().email(),
    displayName: z.string().max(255).optional(),
    provider: z.enum(["smtp", "google", "microsoft"]).default("smtp"),
    dailySendLimit: z.number().int().positive().default(50),
    sendingDomainId: z.string().uuid().optional(),
    smtpHost: z.string().optional(),
    smtpPort: z.number().int().optional(),
    smtpUsername: z.string().optional(),
    smtpPassword: z.string().optional(),
    smtpSecure: z.boolean().optional(),
  imapHost: z.string().optional(),
  imapPort: z.number().int().optional(),
  })
);

const updateInboxBody = z
  .object({
    displayName: z.string().max(255).optional(),
    dailySendLimit: z.number().int().positive().optional(),
    status: z.enum(["active", "paused", "inactive"]).optional(),
    sendingDomainId: z.string().uuid().nullable().optional(),
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

const manualReviewResolveSchema = z.object({
  action: z.enum(["apply", "dismiss"]),
});

const replySchema = z.object({
  text: z.string().min(1),
  html: z.string().optional(),
});

const listThreadsQuerySchema = z.object({
  status: z.enum(THREAD_STATUSES).optional(),
  unread: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  inboxId: z.string().uuid().optional(),
  folder: z.enum(["all", "inbound", "sent"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export async function inboxRoutes(app: FastifyInstance) {
  const db = app.db;

  // GET /inboxes
  app.get("/inboxes", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    if (!db) return reply.send({ workspaceId, data: [], total: 0 });
    const result = await listInboxes(db, workspaceId);
    try {
      const { isWarmupToolConfigured, listWarmupMailboxesByEmail } = await import(
        "../services/warmup-tool.service.js"
      );
      if (isWarmupToolConfigured(app.config)) {
        const byEmail = await listWarmupMailboxesByEmail(db, app.config, workspaceId);
        result.data = result.data.map((inbox) => {
          const email = (inbox as { emailAddress?: string }).emailAddress?.trim().toLowerCase();
          const match = email ? byEmail.get(email) : undefined;
          return {
            ...inbox,
            warmupToolMailboxId: match?.id ?? null,
            warmupToolStatus: match?.status ?? null,
          };
        });
      }
    } catch {
      /* fail-open */
    }
    return reply.send(result);
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

  // POST /inboxes/:id/test-send — verify SMTP/OAuth credentials and activate inbox
  app.post("/inboxes/:id/test-send", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    if (!db) return reply.status(503).send({ error: "database_unavailable" });
    const svc = new InboxService(db, app.config);
    try {
      const result = await svc.testSend(workspaceId, id);
      return reply.send(result);
    } catch (err) {
      if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message });
      app.log.error({ err }, "test-send failed");
      return reply.status(502).send({ error: "smtp_connection_failed" });
    }
  });

  // GET /inboxes/connect/google — initiate Google OAuth for Gmail inbox
  app.get("/inboxes/connect/google", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    try {
      const url = getGoogleConnectUrl(workspaceId, app.config);
      return reply.redirect(url);
    } catch (err) {
      if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  // GET /inboxes/connect/google/callback
  app.get("/inboxes/connect/google/callback", async (request, reply) => {
    const { code, state, error } = request.query as { code?: string; state?: string; error?: string };
    const frontend = (app.config.FRONTEND_URL ?? app.config.CORS_ORIGIN[0] ?? "http://localhost:3000").replace(/\/$/, "");
    // Next.js basePath is "/app" — omitting it 404'd this redirect even on success.
    const failUrl = `${frontend}/app/deliverability?connected=google_error`;
    if (error || !code || !state || !db) return reply.redirect(failUrl);
    try {
      const { redirectUrl } = await handleGoogleCallback(code, state, db, app.config);
      return reply.redirect(redirectUrl);
    } catch (err) {
      app.log.error({ err }, "Google inbox OAuth callback failed");
      return reply.redirect(failUrl);
    }
  });

  // GET /inboxes/connect/microsoft — initiate Microsoft OAuth for Outlook inbox
  app.get("/inboxes/connect/microsoft", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    try {
      const url = getMicrosoftConnectUrl(workspaceId, app.config);
      return reply.redirect(url);
    } catch (err) {
      if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  // GET /inboxes/connect/microsoft/callback
  app.get("/inboxes/connect/microsoft/callback", async (request, reply) => {
    const { code, state, error } = request.query as { code?: string; state?: string; error?: string };
    const frontend = (app.config.FRONTEND_URL ?? app.config.CORS_ORIGIN[0] ?? "http://localhost:3000").replace(/\/$/, "");
    // Next.js basePath is "/app" — omitting it 404'd this redirect even on success.
    const failUrl = `${frontend}/app/deliverability?connected=microsoft_error`;
    if (error || !code || !state || !db) return reply.redirect(failUrl);
    try {
      const { redirectUrl } = await handleMicrosoftCallback(code, state, db, app.config);
      return reply.redirect(redirectUrl);
    } catch (err) {
      app.log.error({ err }, "Microsoft inbox OAuth callback failed");
      return reply.redirect(failUrl);
    }
  });

  // GET /domains
  app.get("/domains", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    if (!db) return reply.send({ workspaceId, data: [], total: 0 });
    return reply.send(await listDomains(db, workspaceId));
  });

  // POST /domains
  app.post("/domains", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    if (!db) return reply.status(503).send({ error: "database_unavailable" });
    const { domain } = z.object({ domain: z.string().min(1) }).parse(request.body ?? {});
    const row = await addDomain(db, workspaceId, domain);
    return reply.status(201).send(row);
  });

  // DELETE /domains/:id
  app.delete("/domains/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    if (!db) return reply.status(503).send({ error: "database_unavailable" });
    const deleted = await removeDomain(db, workspaceId, id);
    if (!deleted) return reply.status(404).send({ error: "domain_not_found" });
    return reply.status(204).send();
  });

  // GET /domains/:id/dns
  app.get("/domains/:id/dns", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    if (!db) return reply.status(503).send({ error: "database_unavailable" });
    const result = await getDomainDns(db, workspaceId, id);
    if (!result) return reply.status(404).send({ error: "domain_not_found" });
    return reply.send(result);
  });

  // POST /domains/:id/verify — live DNS check, updates dns_records + status
  app.post("/domains/:id/verify", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    if (!db) return reply.status(503).send({ error: "database_unavailable" });
    const result = await verifyDomain(db, workspaceId, id);
    if (!result) return reply.status(404).send({ error: "domain_not_found" });
    return reply.send(result);
  });

  // POST /domains/:id/warmup/start
  app.post("/domains/:id/warmup/start", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    if (!db) return reply.status(503).send({ error: "database_unavailable" });
    // Update all inboxes linked to this sending domain
    const { schema: s } = await import("@skout/db");
    await db
      .update(s.inboxes)
      .set({ warmupStatus: "warming", warmupDay: 0, warmupStartedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(s.inboxes.workspaceId, workspaceId), eq(s.inboxes.sendingDomainId, id)));
    return reply.send({ ok: true });
  });

  // POST /domains/:id/warmup/stop
  app.post("/domains/:id/warmup/stop", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    if (!db) return reply.status(503).send({ error: "database_unavailable" });
    const { schema: s } = await import("@skout/db");
    await db
      .update(s.inboxes)
      .set({ warmupStatus: "cold", updatedAt: new Date() })
      .where(and(eq(s.inboxes.workspaceId, workspaceId), eq(s.inboxes.sendingDomainId, id)));
    return reply.send({ ok: true });
  });

  // POST /domains/:id/blacklist-check — manual trigger
  app.post("/domains/:id/blacklist-check", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    if (!db) return reply.status(503).send({ error: "database_unavailable" });
    const { checkDomainBlacklist } = await import("../services/blacklist-check.service.js");
    const { schema: s } = await import("@skout/db");
    const [row] = await db
      .select({ domain: s.sendingDomains.domain })
      .from(s.sendingDomains)
      .where(and(eq(s.sendingDomains.workspaceId, workspaceId), eq(s.sendingDomains.id, id)))
      .limit(1);
    if (!row) return reply.status(404).send({ error: "domain_not_found" });
    const result = await checkDomainBlacklist(row.domain);
    await db
      .update(s.sendingDomains)
      .set({
        blacklistStatus: result.status,
        blacklistedOn: result.listedOn,
        lastCheckedAt: new Date(),
        checkError: result.error ?? null,
        updatedAt: new Date(),
      })
      .where(eq(s.sendingDomains.id, id));
    return reply.send(result);
  });

  // GET /deliverability/metrics — warmup + bounce/spam chart data + summary
  app.get("/deliverability/metrics", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    if (!db) return reply.status(503).send({ error: "database_unavailable" });
    return reply.send(await getDeliverabilityMetrics(db, workspaceId));
  });

  // GET /inbox/threads — filterable by ?status=&unread=true
  app.get("/inbox/threads", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildInboxService(db, app.config);
    if (!svc) return reply.send({ workspaceId, data: [], total: 0 });
    const { status, unread, inboxId, folder, limit, offset } = listThreadsQuerySchema.parse(request.query ?? {});
    try {
      return reply.send(
        await svc.listThreads(workspaceId, {
          status: status as ThreadStatus | undefined,
          unreadOnly: unread,
          inboxId,
          folder: folder === "all" ? undefined : folder,
          limit,
          offset,
        })
      );
    } catch (err) {
      if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message });
      return reply.status(503).send({ error: "service_unavailable" });
    }
  });

  // GET /inbox/unread-counts — workspace unread badge counts by status
  app.get("/inbox/unread-counts", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildInboxService(db, app.config);
    if (!svc) return reply.send({ workspaceId, total: 0, byStatus: {} });
    return reply.send(await svc.getUnreadCounts(workspaceId));
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

  // POST /inbox/threads/:threadId/suggest-reply — one-click AI draft for HITL reply
  app.post("/inbox/threads/:threadId/suggest-reply", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const { threadId } = request.params as { threadId: string };
    if (!db) return reply.status(503).send({ error: "database_unavailable" });
    try {
      const svc = new SuggestReplyService(db, app.config);
      const result = await svc.suggestForThread(workspaceId, threadId, { persistDraft: true });
      return reply.send(result);
    } catch (err) {
      if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message });
      const e = err as { name?: string; message?: string };
      if (e.name === "UnevidencedClaimError") {
        return reply.status(500).send({ error: e.message ?? "Unevidenced AI claim rejected" });
      }
      throw err;
    }
  });

  // POST /inbox/threads/:threadId/read — mark all messages as read
  app.post("/inbox/threads/:threadId/read", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const { threadId } = request.params as { threadId: string };
    const svc = buildInboxService(db, app.config);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    try {
      return reply.send(await svc.markThreadRead(workspaceId, threadId));
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

  // GET /inbox/manual-review — threads awaiting human resolution of a low-confidence AI tag
  app.get("/inbox/manual-review", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildInboxService(db, app.config);
    if (!svc) return reply.send({ workspaceId, data: [], total: 0 });
    return reply.send(await svc.listManualReviewThreads(workspaceId));
  });

  // POST /inbox/threads/:threadId/manual-review/resolve — apply the AI's suggested action, or dismiss it
  app.post("/inbox/threads/:threadId/manual-review/resolve", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const { threadId } = request.params as { threadId: string };
    const svc = buildInboxService(db, app.config);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    try {
      const { action } = manualReviewResolveSchema.parse(request.body ?? {});
      return reply.send(await svc.resolveManualReview(workspaceId, threadId, action));
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
