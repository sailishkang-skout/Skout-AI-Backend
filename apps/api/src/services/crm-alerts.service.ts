import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { getCopsNotificationRecipients, type CopsNotificationRoleKey } from "./cops-notification-routing.js";
import { getHubSpotRateLimitState, hubspotRateLimitKey } from "./hubspot.client.js";

/**
 * COPS-09 CRM sync alerts (expired grant, schema drift, repeated sync failures): an in-app
 * notification to the workspace's Admin and Owner members. Each alert has a dedupe key; the
 * notifications unique index (workspace, user, source_event_id) drops a repeat, so a poll that
 * keeps failing every few minutes does not flood anyone.
 */
const { notifications, crmConnections } = schema;
const RECIPIENT_ROLES: readonly CopsNotificationRoleKey[] = ["admin", "owner"];

function stableId(key: string): string {
  const h = createHash("sha256").update(`crm-alert:${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** UTC day, for alerts that should go out at most once a day. */
export const alertDay = (now: Date = new Date()) => now.toISOString().slice(0, 10);

/** Returns how many notifications were written (0 when this alert was already sent). */
export async function notifyCrmAdmins(
  db: Db,
  input: { workspaceId: string; type: string; title: string; body: string; connectionId?: string | null; dedupeKey: string }
): Promise<number> {
  const recipients = await getCopsNotificationRecipients(db, input.workspaceId, RECIPIENT_ROLES);
  const sourceEventId = stableId(input.dedupeKey);
  let written = 0;
  for (const userId of recipients) {
    const [row] = await db
      .insert(notifications)
      .values({
        workspaceId: input.workspaceId,
        userId,
        type: input.type,
        title: input.title,
        body: input.body,
        entityType: "crm_connection",
        entityId: input.connectionId ?? undefined,
        sourceEventId,
        deliveredChannels: ["in_app"],
      })
      .onConflictDoNothing()
      .returning({ id: notifications.id });
    if (row) written += 1;
  }
  return written;
}

/**
 * Merges keys into crm_connections.settings in one statement (jsonb ||), so concurrent writers
 * (sync, opt-in, mappings) never overwrite each other's keys with a stale copy.
 */
export async function mergeConnectionSettings(db: Db, connectionId: string, patch: Record<string, unknown>): Promise<void> {
  await db
    .update(crmConnections)
    .set({ settings: sql`coalesce(${crmConnections.settings}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`, updatedAt: new Date() })
    .where(eq(crmConnections.id, connectionId));
}

/**
 * Copies this process's HubSpot rate-limit state for an access token onto the connection, so the
 * health API shows it whichever process hit the limit. No-op when the token was never limited.
 */
export async function persistHubSpotRateLimit(db: Db, connectionId: string, accessToken: string): Promise<void> {
  const state = getHubSpotRateLimitState(Date.now(), hubspotRateLimitKey(accessToken));
  if (!state.lastRateLimitedAt) return;
  await mergeConnectionSettings(db, connectionId, {
    rateLimit: { lastRateLimitedAt: state.lastRateLimitedAt, limitedUntil: state.limitedUntil, retryAfterMs: state.retryAfterMs },
  });
}
