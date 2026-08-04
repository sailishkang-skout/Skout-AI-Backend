import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { schema } from "@skout/db";
import { errorResponse, HttpError } from "../utils/http.js";
import { buildBridgeTwiml, dialBridgeCall, isTwilioConfigured } from "../services/twilio.service.js";
import { resolveProspectFields } from "../services/prospect-resolver.service.js";
import { createNotification } from "../services/notifications.service.js";

/** R20.2 — Twilio click-to-call dialer. */
export async function callRoutes(app: FastifyInstance) {
  function db() {
    if (!app.db) throw new HttpError("Database not available", 500);
    return app.db;
  }

  // GET /calls/config — lets the frontend know whether dialing is available before rendering
  // a "Call" button, and whether the current user still needs to set their phone number.
  app.get("/calls/config", async (request, reply) => {
    if (!request.userId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const configured = isTwilioConfigured(app.config);
    let agentPhoneSet = false;
    if (configured) {
      const [row] = await db().select({ phone: schema.users.phone }).from(schema.users).where(eq(schema.users.id, request.userId)).limit(1);
      agentPhoneSet = Boolean(row?.phone);
    }
    return reply.send({ data: { enabled: configured, agentPhoneSet } });
  });

  // POST /calls/dial — { prospectId } or { to } + optional { taskId }
  app.post<{ Body: { prospectId?: string; to?: string; taskId?: string } }>(
    "/calls/dial",
    async (request, reply) => {
      if (!request.workspaceId || !request.userId) {
        return reply.code(401).send(errorResponse("Unauthorized", 401));
      }
      if (!isTwilioConfigured(app.config)) {
        return reply
          .code(422)
          .send(errorResponse("Calling isn't configured yet — set TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_PHONE_NUMBER.", 422));
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
            prospectLabel,
          },
        });
        return reply.code(201).send({ data: call });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Call failed to start";
        return reply.code(502).send(errorResponse(message, 502));
      }
    }
  );

  // --- Public Twilio webhooks (no bearer auth — see isPublicRoute in plugins/auth.ts) ---

  // GET/POST /calls/twiml/bridge?to=<prospectPhone> — Twilio fetches this once the agent leg answers.
  app.route({
    method: ["GET", "POST"],
    url: "/calls/twiml/bridge",
    handler: async (request, reply) => {
      const to = (request.query as { to?: string })?.to;
      if (!to) return reply.code(400).send("Missing to");
      const twiml = buildBridgeTwiml(to, app.config.TWILIO_PHONE_NUMBER ?? "");
      return reply.type("text/xml").send(twiml);
    },
  });

  // POST /calls/status — Twilio call-status callback. Marks the linked task done (if any) and
  // notifies the SDR with the outcome. Not signature-verified yet — see dependency doc.
  app.post("/calls/status", async (request, reply) => {
    const query = request.query as { workspaceId?: string; userId?: string; taskId?: string; prospectLabel?: string };
    const bodyParams = (request.body ?? {}) as Record<string, string>;
    const callStatus = bodyParams.CallStatus ?? "unknown";
    const duration = bodyParams.CallDuration ?? "0";

    if (query.workspaceId && query.userId) {
      if (query.taskId) {
        await db()
          .update(schema.tasks)
          .set({ status: "done", updatedAt: new Date() })
          .where(eq(schema.tasks.id, query.taskId));
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
}
