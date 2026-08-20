import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { schema } from "@skout/db";
import { filterAutoFillablePatch, mergeAutoFillSources, asFieldSourcesMap } from "@skout/shared";
import { errorResponse, HttpError } from "../utils/http.js";
import {
  activeTelecomProvider,
  buildBridgeXml,
  dialBridgeCall,
  isCallingConfigured,
  telecomWebhookBaseUrl,
} from "../services/telecom.service.js";
import { resolveProspectFields } from "../services/prospect-resolver.service.js";
import { createNotification } from "../services/notifications.service.js";
import { extractFieldsFromCallNotes } from "../services/call-notes-extraction.service.js";

/** R20.2 — click-to-call dialer (Twilio or Telnyx). */
export async function callRoutes(app: FastifyInstance) {
  function db() {
    if (!app.db) throw new HttpError("Database not available", 500);
    return app.db;
  }

  // GET /calls/config — lets the frontend know whether dialing is available before rendering
  // a "Call" button, and whether the current user still needs to set their phone number.
  app.get("/calls/config", async (request, reply) => {
    if (!request.userId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const configured = isCallingConfigured(app.config);
    let agentPhoneSet = false;
    if (configured) {
      const [row] = await db().select({ phone: schema.users.phone }).from(schema.users).where(eq(schema.users.id, request.userId)).limit(1);
      agentPhoneSet = Boolean(row?.phone);
    }
    return reply.send({ data: { enabled: configured, agentPhoneSet } });
  });

  // POST /calls/dial — { prospectId } or { to } + optional { taskId, contactId }.
  // `contactId` (native CRM contact uuid) is what lets the status/recording webhooks below log
  // an activity on the right contact's timeline — see R20.2 AC.
  app.post<{ Body: { prospectId?: string; to?: string; taskId?: string; contactId?: string } }>(
    "/calls/dial",
    async (request, reply) => {
      if (!request.workspaceId || !request.userId) {
        return reply.code(401).send(errorResponse("Unauthorized", 401));
      }
      if (!isCallingConfigured(app.config)) {
        return reply
          .code(422)
          .send(
            errorResponse(
              "Calling isn't configured yet — set Telnyx creds (TELNYX_API_KEY/TELNYX_PHONE_NUMBER/TELNYX_CONNECTION_ID) or enable TWILIO_ENABLED with Twilio creds.",
              422
            )
          );
      }

      const [agent] = await db().select({ phone: schema.users.phone }).from(schema.users).where(eq(schema.users.id, request.userId)).limit(1);
      if (!agent?.phone) {
        return reply.code(422).send(errorResponse("Set your phone number in settings before placing calls.", 422));
      }

      let prospectPhone = request.body?.to;
      let prospectLabel = prospectPhone ?? "";
      if (!prospectPhone && request.body?.prospectId) {
        const prospect = await resolveProspectFields(app.config, db(), request.workspaceId, request.body.prospectId);
        prospectPhone = prospect?.phone;
        prospectLabel = prospect?.fullName || request.body.prospectId;
      }
      if (!prospectPhone) {
        return reply.code(400).send(errorResponse("to (or a prospectId with a known phone number) is required", 400));
      }

      try {
        const call = await dialBridgeCall(app.config, {
          agentPhone: agent.phone,
          prospectPhone,
          callbackParams: {
            workspaceId: request.workspaceId,
            userId: request.userId,
            ...(request.body?.taskId ? { taskId: request.body.taskId } : {}),
            ...(request.body?.contactId ? { contactId: request.body.contactId } : {}),
            prospectLabel,
          },
        });

        // R20.2 — durable row the public webhooks below key off `callSid` to log duration,
        // disposition, and (once it finishes processing) the recording URL.
        await db().insert(schema.calls).values({
          workspaceId: request.workspaceId,
          callSid: call.callSid,
          agentUserId: request.userId,
          contactId: request.body?.contactId,
          taskId: request.body?.taskId,
          toPhone: prospectPhone,
          prospectLabel,
          status: call.status,
        });

        return reply.code(201).send({ data: call });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Call failed to start";
        return reply.code(502).send(errorResponse(message, 502));
      }
    }
  );

  /**
   * R13.3 — run the call-notes extraction pass and merge any typed fields it finds into the
   * linked contact/company, tagged source: "call_note". Best-effort: never throws — a failure
   * here must never fail the notes save itself.
   */
  async function applyCallNoteAutoFill(workspaceId: string, contactId: string, notes: string): Promise<void> {
    const extraction = await extractFieldsFromCallNotes(app.config, notes);

    if (extraction.contact) {
      const [contact] = await db()
        .select()
        .from(schema.contacts)
        .where(and(eq(schema.contacts.id, contactId), eq(schema.contacts.workspaceId, workspaceId)))
        .limit(1);
      if (contact) {
        const existingSources = asFieldSourcesMap(contact.fieldSources);
        const { applied } = filterAutoFillablePatch(extraction.contact, existingSources);
        const appliedFields = Object.keys(applied);
        if (appliedFields.length > 0) {
          const nextFieldSources = mergeAutoFillSources(existingSources, appliedFields, "call_note", extraction.contactConfidence);
          await db()
            .update(schema.contacts)
            .set({ ...applied, fieldSources: nextFieldSources, updatedAt: new Date() })
            .where(eq(schema.contacts.id, contact.id));
        }

        if (extraction.company && contact.companyId) {
          const [company] = await db()
            .select()
            .from(schema.companies)
            .where(and(eq(schema.companies.id, contact.companyId), eq(schema.companies.workspaceId, workspaceId)))
            .limit(1);
          if (company) {
            const existingCompanySources = asFieldSourcesMap(company.fieldSources);
            const { applied: companyApplied } = filterAutoFillablePatch(extraction.company, existingCompanySources);
            const companyAppliedFields = Object.keys(companyApplied);
            if (companyAppliedFields.length > 0) {
              const nextCompanySources = mergeAutoFillSources(
                existingCompanySources,
                companyAppliedFields,
                "call_note",
                extraction.companyConfidence
              );
              await db()
                .update(schema.companies)
                .set({ ...companyApplied, fieldSources: nextCompanySources, updatedAt: new Date() })
                .where(eq(schema.companies.id, company.id));
            }
          }
        }
      }
    }
  }

  // PATCH /calls/:id/notes — attach free-text notes to a logged call. Triggers R13.3's
  // call_note auto-fill pipeline on the linked contact/company; the extraction+merge failing
  // never fails the notes save (best-effort, see applyCallNoteAutoFill above).
  app.patch<{ Params: { id: string }; Body: { notes: string } }>("/calls/:id/notes", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const notes = (request.body?.notes ?? "").toString();
    const [callRow] = await db()
      .update(schema.calls)
      .set({ notes, updatedAt: new Date() })
      .where(and(eq(schema.calls.id, request.params.id), eq(schema.calls.workspaceId, request.workspaceId)))
      .returning();
    if (!callRow) return reply.code(404).send(errorResponse("Call not found", 404));

    if (callRow.contactId && notes.trim()) {
      try {
        await applyCallNoteAutoFill(request.workspaceId, callRow.contactId, notes);
      } catch (err) {
        app.log.warn({ err }, "call-note auto-fill failed");
      }
    }

    return reply.send({ data: callRow });
  });

  // --- Public telecom webhooks (no bearer auth — see isPublicRoute in plugins/auth.ts) ---

  // GET/POST /calls/twiml/bridge?to=<prospectPhone>&... — provider fetches this once the agent leg
  // answers. Forwards workspaceId/contactId/taskId/prospectLabel into the recording-status
  // callback URL so that webhook (fired later, async, once Twilio finishes processing the
  // recording) can still attribute it to the right contact.
  app.route({
    method: ["GET", "POST"],
    url: "/calls/twiml/bridge",
    handler: async (request, reply) => {
      const query = request.query as Record<string, string | undefined>;
      const to = query.to;
      if (!to) return reply.code(400).send("Missing to");

      let recordingStatusCallbackUrl: string | undefined;
      const base = telecomWebhookBaseUrl(app.config);
      if (base) {
        const url = new URL("/api/v1/calls/recording-status", base);
        for (const [key, value] of Object.entries(query)) {
          if (value && key !== "to") url.searchParams.set(key, value);
        }
        recordingStatusCallbackUrl = url.toString();
      }

      const twiml = buildBridgeXml(app.config, to, recordingStatusCallbackUrl);
      return reply.type("text/xml").send(twiml);
    },
  });

  /**
   * Creates (or appends to) the `activities` timeline row for a completed call, and marks the
   * linked `calls` row with the given fields. Shared by both the status and recording-status
   * webhooks since either can arrive first depending on Twilio's processing order.
   */
  async function upsertCallActivity(params: {
    workspaceId: string;
    contactId?: string;
    callRow: typeof schema.calls.$inferSelect;
    disposition?: string;
    durationSeconds?: number;
    recordingUrl?: string;
  }) {
    const { workspaceId, contactId, callRow } = params;
    if (!contactId) return;

    if (callRow.activityId) {
      const [existing] = await db().select().from(schema.activities).where(eq(schema.activities.id, callRow.activityId)).limit(1);
      if (existing) {
        const lines = [
          `Disposition: ${params.disposition ?? callRow.status}`,
          `Duration: ${params.durationSeconds ?? callRow.durationSeconds ?? 0}s`,
        ];
        const recordingUrl = params.recordingUrl ?? callRow.recordingUrl;
        if (recordingUrl) lines.push(`Recording: ${recordingUrl}`);
        await db()
          .update(schema.activities)
          .set({ body: lines.join("\n") })
          .where(eq(schema.activities.id, existing.id));
        return;
      }
    }

    const lines = [
      `Disposition: ${params.disposition ?? callRow.status}`,
      `Duration: ${params.durationSeconds ?? callRow.durationSeconds ?? 0}s`,
    ];
    if (params.recordingUrl) lines.push(`Recording: ${params.recordingUrl}`);
    const [activity] = await db()
      .insert(schema.activities)
      .values({
        workspaceId,
        entityType: "contact",
        entityId: contactId,
        activityType: "call",
        subject: `Call ${params.disposition ?? callRow.status}${callRow.prospectLabel ? `: ${callRow.prospectLabel}` : ""}`,
        body: lines.join("\n"),
        ownerId: callRow.agentUserId ?? undefined,
      })
      .returning();
    if (activity) {
      await db().update(schema.calls).set({ activityId: activity.id, updatedAt: new Date() }).where(eq(schema.calls.id, callRow.id));
    }
  }

  // POST /calls/status — Twilio call-status callback. Marks the linked task done (if any),
  // logs a "call" activity on the contact's timeline (duration + disposition, per R20.2 AC),
  // and notifies the SDR. Not signature-verified yet — see dependency doc.
  app.post("/calls/status", async (request, reply) => {
    const query = request.query as {
      workspaceId?: string;
      userId?: string;
      taskId?: string;
      contactId?: string;
      prospectLabel?: string;
    };
    const bodyParams = (request.body ?? {}) as Record<string, string>;
    const callStatus = bodyParams.CallStatus ?? "unknown";
    const duration = Number(bodyParams.CallDuration ?? "0") || 0;
    const callSid = bodyParams.CallSid;

    if (query.workspaceId && query.userId) {
      if (query.taskId) {
        await db()
          .update(schema.tasks)
          .set({ status: "done", updatedAt: new Date() })
          .where(eq(schema.tasks.id, query.taskId));
      }

      if (callSid) {
        const [callRow] = await db()
          .update(schema.calls)
          .set({ status: callStatus, durationSeconds: duration, updatedAt: new Date() })
          .where(eq(schema.calls.callSid, callSid))
          .returning();
        if (callRow) {
          try {
            await upsertCallActivity({
              workspaceId: query.workspaceId,
              contactId: query.contactId ?? callRow.contactId ?? undefined,
              callRow,
              disposition: callStatus,
              durationSeconds: duration,
            });
          } catch (err) {
            app.log.warn({ err }, "Failed to log call activity on contact timeline");
          }
        }
      }

      try {
        await createNotification(db(), app.config, {
          workspaceId: query.workspaceId,
          userId: query.userId,
          type: "call_completed",
          title: `Call ${callStatus}${query.prospectLabel ? `: ${query.prospectLabel}` : ""}`,
          body: `Duration: ${duration}s`,
        });
      } catch (err) {
        app.log.warn({ err }, "Failed to notify call completion");
      }
    }
    reply.code(204).send();
  });

  // POST /calls/recording-status — Twilio's async recording-completion callback (fires once
  // processing finishes, which can be seconds after /calls/status). Attaches RecordingUrl to
  // the same call/activity row created above.
  app.post("/calls/recording-status", async (request, reply) => {
    const query = request.query as { workspaceId?: string; contactId?: string };
    const bodyParams = (request.body ?? {}) as Record<string, string>;
    const recordingUrl = bodyParams.RecordingUrl;
    const callSid = bodyParams.CallSid;

    if (recordingUrl && callSid) {
      const [callRow] = await db()
        .update(schema.calls)
        .set({ recordingUrl, updatedAt: new Date() })
        .where(eq(schema.calls.callSid, callSid))
        .returning();
      if (callRow && query.workspaceId) {
        try {
          await upsertCallActivity({
            workspaceId: query.workspaceId,
            contactId: query.contactId ?? callRow.contactId ?? undefined,
            callRow,
            recordingUrl,
          });
        } catch (err) {
          app.log.warn({ err }, "Failed to attach recording to call activity");
        }
      }
    }
    reply.code(204).send();
  });
}
