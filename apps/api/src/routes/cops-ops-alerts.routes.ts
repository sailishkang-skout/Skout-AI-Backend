import type { FastifyInstance } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { schema, type Db } from "@skout/db";
import { getCopsNotificationRecipients } from "../services/cops-notification-routing.js";

const { notifications } = schema;

/**
 * COPS-07 operational alerts in the web app. Datadog cannot write into the app, so its monitors
 * call this endpoint through a Datadog webhook; it creates an in-app notification for the Admin,
 * owner and Engineering members of the workspace named in OPS_ALERT_WORKSPACE_ID.
 *
 * There is no session. The caller proves itself with the shared secret in the
 * X-Skout-Webhook-Secret header (DATADOG_WEBHOOK_SECRET, kept in the encrypted env file). The
 * endpoint fails closed: without the secret or the workspace configured it refuses every call.
 */
const alertSchema = z
  .object({
    /** Datadog $ALERT_ID and $ALERT_CYCLE_KEY: together they identify one state change of one monitor. */
    alert_id: z.string().min(1).max(200),
    cycle_key: z.string().max(200).optional(),
    /** Datadog $ALERT_TRANSITION, for example Triggered, Recovered, No Data. */
    transition: z.string().min(1).max(60),
    title: z.string().min(1).max(500),
    body: z.string().max(4000).optional(),
    link: z.string().url().max(1000).optional(),
  })
  .strip();

export function secretMatches(given: unknown, expected: string | undefined): boolean {
  if (typeof given !== "string" || !expected) return false;
  // Hash both sides so the comparison takes the same time whatever the length of the guess.
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** A stable id per monitor state change, so a Datadog retry does not notify anyone twice. */
export function alertEventId(alertId: string, cycleKey: string | undefined, transition: string): string {
  const hex = createHash("sha256").update(`datadog:${alertId}:${cycleKey ?? ""}:${transition}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export const OPS_ALERT_ROLE_KEYS = ["admin", "owner", "engineering"] as const;

export async function copsOpsAlertRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

  app.post("/webhooks/datadog/cops-alerts", async (request, reply) => {
    const secret = app.config.DATADOG_WEBHOOK_SECRET;
    const workspaceId = app.config.OPS_ALERT_WORKSPACE_ID;
    if (!secret || !workspaceId) {
      app.log.error("Datadog alert webhook called but DATADOG_WEBHOOK_SECRET or OPS_ALERT_WORKSPACE_ID is not set");
      return reply.status(503).send({ error: "Operational alerts are not configured" });
    }
    if (!secretMatches(request.headers["x-skout-webhook-secret"], secret)) {
      return reply.status(401).send({ error: "Invalid webhook secret" });
    }
    const parsed = alertSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(422).send({ error: "Invalid alert", fields: parsed.error.issues.map((i) => i.path.join(".")) });
    const alert = parsed.data;

    const recipients = await getCopsNotificationRecipients(db, workspaceId, OPS_ALERT_ROLE_KEYS);
    const sourceEventId = alertEventId(alert.alert_id, alert.cycle_key, alert.transition);
    const body = [alert.body?.trim(), alert.link].filter(Boolean).join("\n\n") || "See Datadog for details.";
    let created = 0;
    for (const userId of recipients) {
      const rows = await db
        .insert(notifications)
        .values({
          workspaceId,
          userId,
          type: "cops.ops_alert",
          title: `[${alert.transition}] ${alert.title}`.slice(0, 500),
          body,
          entityType: "ops_alert",
          entityId: alert.alert_id,
          sourceEventId,
          deliveredChannels: ["in_app"],
        })
        .onConflictDoNothing()
        .returning({ id: notifications.id });
      created += rows.length;
    }
    // No recipients is worth knowing about: the alert reached nobody in the app.
    if (recipients.length === 0) app.log.warn({ workspaceId }, "Datadog alert had no Admin or Engineering recipients");
    return reply.send({ ok: true, recipients: recipients.length, created });
  });
}
