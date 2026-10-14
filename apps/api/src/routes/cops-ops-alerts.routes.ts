import type { FastifyInstance } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { schema, type Db } from "@skout/db";
import { getCopsNotificationRecipients } from "../services/cops-notification-routing.js";

const { notifications } = schema;

/**
 * COPS-07 operational alerts in the web app, from any alerting service that can call a webhook
 * (GCP Cloud Monitoring today; Aditya, 2026-10-14: no Datadog). It creates an in-app notification
 * for the Admin, owner and Engineering members of the workspace in OPS_ALERT_WORKSPACE_ID.
 *
 * There is no session. Cloud Monitoring's "webhook with basic auth" channel sends the shared
 * secret (OPS_ALERT_WEBHOOK_SECRET) as the basic-auth password; any user name is accepted. The
 * endpoint fails closed: without the secret or the workspace configured it refuses every call.
 */
const incidentSchema = z
  .object({
    incident: z
      .object({
        incident_id: z.string().min(1).max(200),
        /** "open" when the condition starts, "closed" when it clears. */
        state: z.string().min(1).max(40),
        policy_name: z.string().min(1).max(500),
        condition_name: z.string().max(500).optional(),
        summary: z.string().max(4000).optional(),
        url: z.string().url().max(2000).optional(),
      })
      .passthrough(),
  })
  .passthrough();

export function secretMatches(given: unknown, expected: string | undefined): boolean {
  if (typeof given !== "string" || !given || !expected) return false;
  // Hash both sides so the comparison takes the same time whatever the length of the guess.
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** The password of a Basic Authorization header, or null. */
export function basicAuthPassword(header: unknown): string | null {
  if (typeof header !== "string" || !header.startsWith("Basic ")) return null;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const i = decoded.indexOf(":");
  return i < 0 ? null : decoded.slice(i + 1);
}

/** A stable id per incident state, so a retried delivery does not notify anyone twice. */
export function alertEventId(incidentId: string, state: string): string {
  const hex = createHash("sha256").update(`ops-alert:${incidentId}:${state}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export const OPS_ALERT_ROLE_KEYS = ["admin", "owner", "engineering"] as const;

export async function copsOpsAlertRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

  app.post("/webhooks/ops-alerts", async (request, reply) => {
    const secret = app.config.OPS_ALERT_WEBHOOK_SECRET;
    const workspaceId = app.config.OPS_ALERT_WORKSPACE_ID;
    if (!secret || !workspaceId) {
      app.log.error("Ops alert webhook called but OPS_ALERT_WEBHOOK_SECRET or OPS_ALERT_WORKSPACE_ID is not set");
      return reply.status(503).send({ error: "Operational alerts are not configured" });
    }
    if (!secretMatches(basicAuthPassword(request.headers.authorization), secret)) {
      return reply.status(401).send({ error: "Invalid webhook credentials" });
    }
    const parsed = incidentSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(422).send({ error: "Invalid alert", fields: parsed.error.issues.map((i) => i.path.join(".")) });
    const { incident } = parsed.data;
    const label = incident.state === "closed" ? "Resolved" : incident.state === "open" ? "Alert" : incident.state;

    const recipients = await getCopsNotificationRecipients(db, workspaceId, OPS_ALERT_ROLE_KEYS);
    const sourceEventId = alertEventId(incident.incident_id, incident.state);
    const body = [incident.summary?.trim(), incident.url].filter(Boolean).join("\n\n") || "See Cloud Monitoring for details.";
    let created = 0;
    for (const userId of recipients) {
      const rows = await db
        .insert(notifications)
        .values({
          workspaceId,
          userId,
          type: "cops.ops_alert",
          title: `[${label}] ${incident.policy_name}`.slice(0, 500),
          body,
          entityType: "ops_alert",
          entityId: incident.incident_id,
          sourceEventId,
          deliveredChannels: ["in_app"],
        })
        .onConflictDoNothing()
        .returning({ id: notifications.id });
      created += rows.length;
    }
    // No recipients is worth knowing about: the alert reached nobody in the app.
    if (recipients.length === 0) app.log.warn({ workspaceId }, "Ops alert had no Admin or Engineering recipients");
    return reply.send({ ok: true, recipients: recipients.length, created });
  });
}
