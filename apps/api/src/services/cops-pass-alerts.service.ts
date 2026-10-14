import { createHash } from "node:crypto";
import { schema, type Db } from "@skout/db";
import { getCopsNotificationRecipients, type CopsNotificationRoleKey } from "./cops-notification-routing.js";
import type { PassFailure } from "./cops-subscriptions.service.js";

/**
 * COPS-08: an in-app alert when the subscription billing pass or the renewal pass cannot process
 * a subscription (Aditya, 2026-10-14; Datadog is not used). One alert per workspace, pass and
 * day, to Admin, Owner and Engineering, so a pass that keeps failing every 10 minutes does not
 * flood anyone. The failed subscriptions are retried on every pass.
 */
const { notifications } = schema;
const RECIPIENT_ROLES: readonly CopsNotificationRoleKey[] = ["admin", "owner", "engineering"];
const LABEL = { billing: "Subscription billing", renewal: "Renewal" } as const;

/** A stable id per workspace, pass and UTC day; the notifications unique index dedupes on it. */
function dailyAlertId(pass: string, workspaceId: string, now: Date): string {
  const h = createHash("sha256").update(`cops-pass-alert:${pass}:${workspaceId}:${now.toISOString().slice(0, 10)}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Returns how many notifications were written (0 when today's alert was already sent). */
export async function notifyPassFailures(db: Db, pass: keyof typeof LABEL, failures: PassFailure[], now: Date = new Date()): Promise<number> {
  const byWorkspace = new Map<string, PassFailure[]>();
  for (const f of failures) byWorkspace.set(f.workspace_id, [...(byWorkspace.get(f.workspace_id) ?? []), f]);
  let written = 0;
  for (const [workspaceId, list] of byWorkspace) {
    const recipients = await getCopsNotificationRecipients(db, workspaceId, RECIPIENT_ROLES);
    const title = `${LABEL[pass]} pass failed for ${list.length} subscription${list.length === 1 ? "" : "s"}`;
    const body = [
      ...list.slice(0, 3).map((f) => `${f.subscription_id}: ${f.error}`),
      ...(list.length > 3 ? [`and ${list.length - 3} more`] : []),
      "They are retried on every pass. Runbook: docs/runbooks/cops-commercial-advanced.md (The billing or renewal pass is not running).",
    ].join("\n");
    const sourceEventId = dailyAlertId(pass, workspaceId, now);
    for (const userId of recipients) {
      const [row] = await db
        .insert(notifications)
        .values({ workspaceId, userId, type: `cops.${pass}_pass_failed`, title, body, entityType: "subscription", entityId: list[0]!.subscription_id, sourceEventId, deliveredChannels: ["in_app"] })
        .onConflictDoNothing()
        .returning({ id: notifications.id });
      if (row) written += 1;
    }
  }
  return written;
}
