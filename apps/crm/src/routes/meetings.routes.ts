import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { schema } from "@skout/db";
import { meetingCreateSchema, meetingListQuerySchema, meetingUpdateSchema } from "@skout/shared";
import { HttpError } from "@skout/auth";
import { parseIdParam } from "../utils/http.js";
import { requireRole } from "../utils/require-role.js";
import { buildActivitiesService } from "../services/activities.service.js";
import { buildMeetingsService } from "../services/meetings.service.js";
import { buildAuditService } from "../services/audit.service.js";
import { buildCompaniesService } from "../services/companies.service.js";
import { buildContactsService } from "../services/contacts.service.js";
import { isMeetingBotConfigured, scheduleMeetingBot } from "../services/meeting-bot.service.js";

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export async function meetingsRoutes(app: FastifyInstance) {
  const service = () => {
    const db = app.db ?? null;
    const activitiesService = buildActivitiesService(db);
    return buildMeetingsService(db, activitiesService);
  };

  const contactsSvc = () => {
    const db = app.db ?? null;
    const auditService = buildAuditService(db);
    const companiesService = buildCompaniesService(db, auditService);
    return buildContactsService(db, companiesService, auditService);
  };

  const companiesSvc = () => {
    const db = app.db ?? null;
    const auditService = buildAuditService(db);
    return buildCompaniesService(db, auditService);
  };

  // GET /meetings/bot-config — lets the frontend know whether to show "Schedule bot" at all.
  app.get("/meetings/bot-config", async () => {
    return { enabled: isMeetingBotConfigured(app.config) };
  });

  app.get("/meetings", async (request) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const query = meetingListQuerySchema.parse(request.query);
    const result = await svc.list(workspaceId, query);
    return { ...result, workspaceId };
  });

  app.post("/meetings", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const input = meetingCreateSchema.parse(request.body);
    const meeting = await svc.create(workspaceId, request.userId, input);
    return reply.code(201).send(meeting);
  });

  app.get("/meetings/:id", async (request, reply) => {
    const id = parseIdParam(request);
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const meeting = await svc.getById(workspaceId, id);
    if (!meeting) throw new HttpError("meeting_not_found", 404);
    return reply.send(meeting);
  });

  app.patch("/meetings/:id", async (request, reply) => {
    const id = parseIdParam(request);
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const input = meetingUpdateSchema.parse(request.body);
    const meeting = await svc.update(workspaceId, id, input);
    if (!meeting) throw new HttpError("meeting_not_found", 404);
    return reply.send(meeting);
  });

  app.delete("/meetings/:id", async (request, reply) => {
    const id = parseIdParam(request);
    const workspaceId = request.workspaceId ?? "unknown";
    requireRole(request, ["owner", "admin"]);
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const deleted = await svc.softDelete(workspaceId, id);
    if (!deleted) throw new HttpError("meeting_not_found", 404);
    return reply.code(204).send();
  });

  // POST /meetings/:id/schedule-bot — R16.2. Requires meetingUrl already set on the meeting.
  app.post("/meetings/:id/schedule-bot", async (request, reply) => {
    const id = parseIdParam(request);
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    if (!isMeetingBotConfigured(app.config)) {
      throw new HttpError("meeting_bot_not_configured", 422, {
        reason: "Set MEETING_BOT_PROVIDER and MEETING_BOT_API_KEY to enable bot join.",
      });
    }

    const meeting = await svc.getById(workspaceId, id);
    if (!meeting) throw new HttpError("meeting_not_found", 404);
    if (!meeting.meetingUrl) {
      throw new HttpError("meeting_url_required", 400, { reason: "Set a Zoom/Meet/Teams link on this meeting first." });
    }

    const base = app.config.CRM_PUBLIC_URL ?? app.config.FRONTEND_URL;
    if (!base) throw new HttpError("crm_public_url_not_configured", 500);
    const webhookUrl = new URL("/api/v1/meetings/webhook", base);
    if (app.config.MEETING_BOT_WEBHOOK_SECRET) {
      webhookUrl.searchParams.set("secret", app.config.MEETING_BOT_WEBHOOK_SECRET);
    }

    const { botExternalId } = await scheduleMeetingBot(app.config, meeting.meetingUrl, webhookUrl.toString());
    const updated = await svc.setBotScheduled(workspaceId, id, botExternalId);
    return reply.send(updated);
  });

  // POST /api/v1/meetings/webhook — public (vendor-called). See isPublicRoute allowlist in plugins/auth.ts.
  // Normalized payload (adapt per-vendor in a thin translation layer if the chosen vendor's
  // shape differs — Recall.ai's `transcript.done` event maps directly to this):
  //   { botExternalId, status, transcript?, transcriptUrl?, recordingUrl?, summary?,
  //     extractedFields?: { contact?: {...}, company?: {...} } }
  app.post("/meetings/webhook", async (request, reply) => {
    const secretParam = (request.query as { secret?: string })?.secret;
    if (app.config.MEETING_BOT_WEBHOOK_SECRET) {
      if (!secretParam || !timingSafeEqualStrings(secretParam, app.config.MEETING_BOT_WEBHOOK_SECRET)) {
        return reply.code(401).send({ error: "invalid_webhook_secret" });
      }
    }

    const body = (request.body ?? {}) as {
      botExternalId?: string;
      status?: string;
      transcript?: string;
      transcriptUrl?: string;
      recordingUrl?: string;
      summary?: string;
      extractedFields?: { contact?: Record<string, unknown>; company?: Record<string, unknown> };
    };

    if (!body.botExternalId) return reply.code(400).send({ error: "botExternalId_required" });

    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const meetingRow = await svc.findByBotExternalId(body.botExternalId);
    if (!meetingRow) return reply.code(404).send({ error: "meeting_not_found_for_bot" });

    const updated = await svc.applyWebhookUpdate(meetingRow.id, {
      botStatus: body.status,
      transcript: body.transcript,
      transcriptUrl: body.transcriptUrl,
      recordingUrl: body.recordingUrl,
      summary: body.summary,
    });

    // R16.3 — auto-fill CRM fields from the transcript, when the vendor/pipeline supplies
    // structured extractedFields. Uses the exact same provenance-tracked auto-fill target
    // R13.3 built for enrichment, with source="meeting_bot" — manual edits still win forever.
    if (body.extractedFields?.contact && meetingRow.contactId) {
      const svc2 = contactsSvc();
      if (svc2) {
        await svc2.autoFill(meetingRow.workspaceId, meetingRow.contactId, body.extractedFields.contact, "meeting_bot");
      }
    }
    if (body.extractedFields?.company && meetingRow.companyId) {
      const svc3 = companiesSvc();
      if (svc3) {
        await svc3.autoFill(meetingRow.workspaceId, meetingRow.companyId, body.extractedFields.company, "meeting_bot");
      }
    }

    // Best-effort in-app notification to the organizer — same `notifications` table apps/api's
    // R17.1 writes to; email/Slack delivery isn't duplicated here (that logic lives in apps/api).
    if (app.db && meetingRow.organizerId) {
      try {
        await app.db.insert(schema.notifications).values({
          workspaceId: meetingRow.workspaceId,
          userId: meetingRow.organizerId,
          type: "meeting_transcript_ready",
          title: `Transcript ready: ${meetingRow.title}`,
          body: updated?.summary ?? "A meeting transcript just came in.",
          entityType: "meeting",
          entityId: meetingRow.id,
          deliveredChannels: ["in_app"],
        });
      } catch (err) {
        app.log.warn({ err }, "Failed to write meeting-transcript notification");
      }
    }

    return reply.code(204).send();
  });
}
