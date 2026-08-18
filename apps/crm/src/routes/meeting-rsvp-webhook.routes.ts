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

const { meetingAttendees } = schema;

const PARTSTAT_TO_RSVP: Record<string, string> = {
  ACCEPTED: "accepted",
  DECLINED: "declined",
  TENTATIVE: "tentative",
  "NEEDS-ACTION": "needs-action",
};

function extractPartstat(icsContent: string): string | null {
  // node-ical's parsed attendee shape varies (single object vs array) across real-world
  // replies, so a direct regex scan of the raw content is the robust extraction here.
  ical.sync.parseICS(icsContent);
  const match = icsContent.match(/PARTSTAT=([A-Z-]+)/);
  return match ? match[1] : null;
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

    const partstat = extractPartstat(body.icsReplyContent);
    const rsvpStatus = partstat ? PARTSTAT_TO_RSVP[partstat] : undefined;
    if (!rsvpStatus) {
      return reply.status(422).send({ error: "unrecognized_partstat" });
    }

    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const [updated] = await app.db
      .update(meetingAttendees)
      .set({ rsvpStatus, respondedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(meetingAttendees.meetingId, body.meetingId), eq(meetingAttendees.email, body.attendeeEmail)))
      .returning();

    if (!updated) return reply.status(404).send({ error: "attendee_not_found" });
    return reply.send({ ok: true, rsvpStatus });
  });
}
