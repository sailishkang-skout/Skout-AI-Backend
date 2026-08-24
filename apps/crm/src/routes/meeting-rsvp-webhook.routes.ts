import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import * as ical from "node-ical";
import { schema } from "@skout/db";
import { verifyRsvpWebhookSignature } from "../utils/webhook-signature.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
  }
}

const { meetingAttendees, meetings } = schema;

const PARTSTAT_TO_RSVP: Record<string, string> = {
  ACCEPTED: "accepted",
  DECLINED: "declined",
  TENTATIVE: "tentative",
  "NEEDS-ACTION": "needs-action",
};

interface IcalAttendee {
  val?: string;
  params?: { PARTSTAT?: string };
}

/**
 * Parses a METHOD:REPLY .ics payload and returns the PARTSTAT for the specific attendee
 * matching `attendeeEmail`, but only if the event's own UID matches `expectedIcsUid` — a reply
 * claiming a different meeting's UID is rejected rather than trusted. A quoted original
 * METHOD:REQUEST (which every attendee shows as NEEDS-ACTION) is a different UID/SEQUENCE
 * component and is naturally skipped by this per-attendee, per-UID match.
 */
function extractPartstatForAttendee(
  icsContent: string,
  expectedIcsUid: string,
  attendeeEmail: string
): string | null {
  const parsed = ical.sync.parseICS(icsContent);
  const normalizedEmail = `mailto:${attendeeEmail}`.toLowerCase();

  for (const component of Object.values(parsed)) {
    if (component.type !== "VEVENT" || component.uid !== expectedIcsUid) continue;

    const attendees = component.attendee
      ? Array.isArray(component.attendee)
        ? component.attendee
        : [component.attendee]
      : [];

    for (const attendee of attendees as IcalAttendee[]) {
      if (attendee.val?.toLowerCase() === normalizedEmail) {
        return attendee.params?.PARTSTAT ?? null;
      }
    }
  }
  return null;
}

export async function meetingRsvpWebhookRoutes(app: FastifyInstance) {
  app.post("/webhooks/meeting-rsvp", async (request: FastifyRequest, reply) => {
    const secret = app.config.MEETING_RSVP_WEBHOOK_SECRET;
    const signature = request.headers["x-rsvp-signature"];
    const rawBody = request.rawBody ?? JSON.stringify(request.body ?? {});

    if (!secret) {
      app.log.warn("MEETING_RSVP_WEBHOOK_SECRET not set — rejecting inbound RSVP webhook");
      return reply.status(503).send({ error: "rsvp_webhook_not_configured" });
    }
    if (typeof signature !== "string" || !verifyRsvpWebhookSignature(rawBody, signature, secret)) {
      return reply.status(400).send({ error: "invalid_signature" });
    }

    const body = (typeof request.body === "string" ? JSON.parse(request.body) : request.body) as {
      meetingId?: string;
      attendeeEmail?: string;
      icsReplyContent?: string;
    };
    if (!body.meetingId || !body.attendeeEmail || !body.icsReplyContent) {
      return reply.status(400).send({ error: "missing_fields" });
    }

    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });

    const [meeting] = await app.db
      .select({ icsUid: meetings.icsUid })
      .from(meetings)
      .where(eq(meetings.id, body.meetingId))
      .limit(1);
    if (!meeting?.icsUid) return reply.status(404).send({ error: "meeting_not_found" });

    const partstat = extractPartstatForAttendee(body.icsReplyContent, meeting.icsUid, body.attendeeEmail);
    const rsvpStatus = partstat ? PARTSTAT_TO_RSVP[partstat] : undefined;
    if (!rsvpStatus) {
      return reply.status(422).send({ error: "unrecognized_partstat" });
    }

    const [updated] = await app.db
      .update(meetingAttendees)
      .set({ rsvpStatus, respondedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(meetingAttendees.meetingId, body.meetingId), eq(meetingAttendees.email, body.attendeeEmail)))
      .returning();

    if (!updated) return reply.status(404).send({ error: "attendee_not_found" });
    return reply.send({ ok: true, rsvpStatus });
  });
}
