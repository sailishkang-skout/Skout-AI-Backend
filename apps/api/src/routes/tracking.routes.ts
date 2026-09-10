import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { schema } from "@skout/db";
import { decodeTrackingToken, recordTrackingEvent, TRANSPARENT_GIF } from "../services/tracking.service.js";

const { sequenceEnrollments } = schema;

/**
 * Public (unauthenticated) endpoints that recipients' mail clients/browsers hit directly —
 * tokens are self-verifying (HMAC-signed), so no auth/workspace header is required or trusted.
 */
export async function trackingRoutes(app: FastifyInstance) {
  app.get<{ Params: { token: string } }>("/track/open/:token", async (request, reply) => {
    reply.header("Content-Type", "image/gif");
    reply.header("Cache-Control", "no-store, no-cache, must-revalidate, private");

    const db = app.db;
    const payload = decodeTrackingToken(app.config, request.params.token);
    if (payload && db) {
      try {
        const [enrollment] = await db
          .select({ workspaceId: sequenceEnrollments.workspaceId })
          .from(sequenceEnrollments)
          .where(eq(sequenceEnrollments.id, payload.enrollmentId))
          .limit(1);
        if (enrollment) {
          await recordTrackingEvent(db, {
            workspaceId: enrollment.workspaceId,
            enrollmentId: payload.enrollmentId,
            enrollmentStepId: payload.enrollmentStepId,
            eventType: "open",
            userAgent: request.headers["user-agent"],
            ipAddress: request.ip,
          });
        }
      } catch (err) {
        app.log.error({ err }, "Failed to record open tracking event");
      }
    }

    return reply.send(TRANSPARENT_GIF);
  });

  app.get<{ Params: { token: string } }>("/track/click/:token", async (request, reply) => {
    const db = app.db;
    const payload = decodeTrackingToken(app.config, request.params.token);
    if (!payload?.url) {
      return reply.status(400).send({ error: "invalid_token" });
    }

    if (db) {
      try {
        const [enrollment] = await db
          .select({ workspaceId: sequenceEnrollments.workspaceId })
          .from(sequenceEnrollments)
          .where(eq(sequenceEnrollments.id, payload.enrollmentId))
          .limit(1);
        if (enrollment) {
          await recordTrackingEvent(db, {
            workspaceId: enrollment.workspaceId,
            enrollmentId: payload.enrollmentId,
            enrollmentStepId: payload.enrollmentStepId,
            eventType: "click",
            url: payload.url,
            userAgent: request.headers["user-agent"],
            ipAddress: request.ip,
          });
        }
      } catch (err) {
        app.log.error({ err }, "Failed to record click tracking event");
      }
    }

    return reply.redirect(payload.url, 302);
  });
}
