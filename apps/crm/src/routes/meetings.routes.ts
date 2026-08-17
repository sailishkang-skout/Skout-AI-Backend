import { timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { schema } from "@skout/db";
import { meetingCreateSchema, meetingInviteeSchema, meetingListQuerySchema, meetingUpdateSchema, findCalendarConnectionForUser, listGoogleCalendarEvents, resolveGoogleCalendarAccessToken } from "@skout/shared";
import { z } from "zod";
import { HttpError } from "@skout/auth";
import { parseIdParam } from "../utils/http.js";
import { requireRole } from "../utils/require-role.js";
import { buildActivitiesService } from "../services/activities.service.js";
import { buildMeetingsService } from "../services/meetings.service.js";
import { buildAuditService } from "../services/audit.service.js";
import { buildCompaniesService } from "../services/companies.service.js";
import { buildContactsService } from "../services/contacts.service.js";
import { buildDealsService } from "../services/deals.service.js";
import { buildPipelinesService } from "../services/pipelines.service.js";
import { isMeetingBotConfigured, scheduleMeetingBot } from "../services/meeting-bot.service.js";
import { createCalendarEvent } from "../services/google-calendar.service.js";
import { extractFieldsFromTranscript, isTranscriptExtractionConfigured } from "../services/transcript-extraction.service.js";

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

  const dealsSvc = () => {
    const db = app.db ?? null;
    const auditService = buildAuditService(db);
    const companiesService = buildCompaniesService(db, auditService);
    const pipelinesService = buildPipelinesService(db, auditService);
    const activitiesService = buildActivitiesService(db);
    return buildDealsService(db, companiesService, pipelinesService, activitiesService, auditService);
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

  // GET /meetings/google-events?from=&to= — everything on the current user's connected Google
  // Calendar in range, for the calendar view to overlay alongside native `meetings` rows. This
  // is what makes events created directly in Google Calendar (not through Skout) show up too.
  // Read-only display merge, not a sync: nothing here is written back to `meetings`.
  app.get("/meetings/google-events", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    if (!app.db) throw new HttpError("database_unavailable", 503);
    if (!request.userId) throw new HttpError("unauthenticated", 401);

    const { from, to } = z
      .object({ from: z.string().min(1), to: z.string().min(1) })
      .parse(request.query);
    const timeMin = new Date(from);
    const timeMax = new Date(to);
    if (Number.isNaN(timeMin.getTime()) || Number.isNaN(timeMax.getTime())) {
      throw new HttpError("invalid_datetime_range", 400);
    }

    const connection = await findCalendarConnectionForUser(app.db, request.userId, workspaceId);
    // Not connected isn't an error for this endpoint — the calendar just shows Skout-native
    // meetings only, same as it did before this existed.
    if (!connection) return reply.send({ data: [], connected: false });

    try {
      const accessToken = await resolveGoogleCalendarAccessToken(connection, app.db, app.config);
      const events = await listGoogleCalendarEvents(accessToken, { timeMin, timeMax });
      return reply.send({ data: events, connected: true });
    } catch (err) {
      // Best-effort overlay — a transient Google API hiccup must not break the whole calendar
      // page, which still has its own native meetings to fall back to.
      app.log.warn({ err }, "Failed to fetch Google Calendar events");
      return reply.send({ data: [], connected: true, error: "google_fetch_failed" });
    }
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

  // POST /meetings/:id/schedule-google — creates a real Google Calendar event with a Meet
  // link + invites attendees (Google sends the invite emails itself). Requires the organizer
  // to have connected their Google Calendar via apps/api's /calendar/connect/google first.
  app.post("/meetings/:id/schedule-google", async (request, reply) => {
    const id = parseIdParam(request);
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);
    if (!app.db) throw new HttpError("database_unavailable", 503);

    const body = z.object({ invitees: z.array(meetingInviteeSchema).optional() }).parse(request.body ?? {});

    const meeting = await svc.getById(workspaceId, id);
    if (!meeting) throw new HttpError("meeting_not_found", 404);
    if (!meeting.organizerId) {
      throw new HttpError("meeting_organizer_required", 400, {
        reason: "Set an organizer on this meeting before scheduling it on Google Calendar.",
      });
    }

    const [connection] = await app.db
      .select()
      .from(schema.calendarConnections)
      .where(
        and(
          eq(schema.calendarConnections.workspaceId, workspaceId),
          eq(schema.calendarConnections.userId, meeting.organizerId)
        )
      )
      .limit(1);
    if (!connection) {
      throw new HttpError("google_calendar_not_connected", 422, {
        reason: "The meeting organizer hasn't connected their Google Calendar yet.",
      });
    }

    const invitees = body.invitees ?? meeting.invitees;
    const accessToken = await resolveGoogleCalendarAccessToken(connection, app.db, app.config);
    const event = await createCalendarEvent(accessToken, {
      title: meeting.title,
      scheduledAt: new Date(meeting.scheduledAt),
      durationMinutes: meeting.durationMinutes,
      attendees: invitees.map((i) => ({ email: i.email, displayName: i.name })),
      // Patch the existing event in place when this meeting was already scheduled on Google —
      // otherwise every re-save (e.g. adding an invitee) minted a duplicate event with a
      // different Meet link instead of updating attendees on the one everyone already has.
      existingEventId: meeting.googleEventId ?? undefined,
    });

    const updated = await svc.setGoogleEvent(workspaceId, id, {
      meetingUrl: event.hangoutLink,
      googleEventId: event.googleEventId,
      googleCalendarId: event.googleCalendarId,
      invitees,
    });
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
      /** R16.2 AC — posted to the CRM activity timeline alongside the summary, when supplied. */
      actionItems?: string[];
      // R13.3 — vendor/pipeline may score its own extraction; falls back to a per-source
      // default in mergeAutoFillSources() when omitted, so a confidence value is never missing.
      extractedFieldsConfidence?: number;
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

    // R16.3 — when the vendor/pipeline doesn't supply its own structured extractedFields, run
    // real LLM extraction on the transcript text ourselves (see transcript-extraction.service.ts)
    // rather than doing nothing. Vendor-supplied extractedFields, when present, still win — a
    // vendor's own extraction is likely purpose-built for their transcript format.
    let extraction: Awaited<ReturnType<typeof extractFieldsFromTranscript>> = {};
    if (!body.extractedFields && body.transcript && isTranscriptExtractionConfigured(app.config)) {
      try {
        extraction = await extractFieldsFromTranscript(app.config, body.transcript);
      } catch (err) {
        app.log.warn({ err }, "Transcript LLM extraction failed");
      }
    }

    // R16.2 AC — post the summary/action items/next-steps/stakeholders to the linked
    // contact/company/deal's activity timeline, not just the meeting row's own summary column.
    if (updated) {
      try {
        await svc.recordTranscriptActivity(
          meetingRow.workspaceId,
          updated,
          body.summary,
          body.actionItems,
          extraction.nextSteps,
          extraction.stakeholders
        );
      } catch (err) {
        app.log.warn({ err }, "Failed to post transcript summary to activity timeline");
      }
    }

    // R13.3/R16.3 — auto-fill CRM fields from the transcript. Uses the exact same
    // provenance-tracked auto-fill target R13.3 built for enrichment, with source="meeting_bot"
    // — manual edits still win forever. Vendor-supplied extractedFields take priority; our own
    // LLM extraction (with its own per-group confidence) fills in when the vendor didn't supply any.
    const contactFields = body.extractedFields?.contact ?? extraction.contact;
    const contactConfidence = body.extractedFields?.contact ? body.extractedFieldsConfidence : extraction.contactConfidence;
    if (contactFields && meetingRow.contactId) {
      const svc2 = contactsSvc();
      if (svc2) {
        await svc2.autoFill(meetingRow.workspaceId, meetingRow.contactId, contactFields, "meeting_bot", contactConfidence);
      }
    }

    const companyFields = body.extractedFields?.company ?? extraction.company;
    const companyConfidence = body.extractedFields?.company ? body.extractedFieldsConfidence : extraction.companyConfidence;
    if (companyFields && meetingRow.companyId) {
      const svc3 = companiesSvc();
      if (svc3) {
        await svc3.autoFill(meetingRow.workspaceId, meetingRow.companyId, companyFields, "meeting_bot", companyConfidence);
      }
    }

    // R16.3 — budget/timeline (amount/closeDate), extraction-only (no vendor extractedFields
    // equivalent exists for deals today).
    if (extraction.deal && meetingRow.dealId) {
      const svc4 = dealsSvc();
      if (svc4) {
        await svc4.autoFill(meetingRow.workspaceId, meetingRow.dealId, extraction.deal, "meeting_bot", extraction.dealConfidence);
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
