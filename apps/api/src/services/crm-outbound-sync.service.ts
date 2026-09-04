import { eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo } from "@skout/db";
import { buildIdempotencyKey, crmSyncOwnedPatch, type CrmSyncEntityType } from "@skout/shared";
import { createLogger } from "@skout/observability";

const log = createLogger("crm-outbound-sync");
const { crmConnections, crmNativeLinks, crmOutboundWrites } = schema;

/**
 * §8.12 Task ADI-10 — the push-back trigger. Any mutation path that changes a Skout-native
 * contact/deal field should call this after a successful write. It's a no-op (not an error) in
 * every case where there's nothing meaningful to push: no CRM-sync-owned field in the patch, no
 * connected CRM, or no linked record on the other side (nothing pulled from HubSpot for this
 * entity yet, so there's no HubSpot id to push an update to).
 *
 * Queues into crm_outbound_writes rather than pushing synchronously — the outbound-write worker
 * (crm-outbound-write.worker.ts) claims it via the execution-intent library and checks the
 * reverse "manual wins" conflict rule (has HubSpot's own value changed more recently than this
 * edit?) right before the real HTTP call, using the freshest crm_native_links data at claim time.
 */
export async function queueCrmOutboundWriteIfOwned(
  db: Db,
  workspaceId: string,
  entityType: CrmSyncEntityType,
  entityId: string,
  patch: Record<string, unknown>,
  changedAt = new Date()
): Promise<void> {
  const owned = crmSyncOwnedPatch(entityType, patch);
  if (Object.keys(owned).length === 0) return;

  const [connection] = await db
    .select({ id: crmConnections.id })
    .from(crmConnections)
    .where(scopedTo(crmConnections, workspaceId, eq(crmConnections.provider, "hubspot")))
    .limit(1);
  if (!connection) return;

  const [link] = await db
    .select({ id: crmNativeLinks.id })
    .from(crmNativeLinks)
    .where(
      scopedTo(
        crmNativeLinks,
        workspaceId,
        eq(crmNativeLinks.connectionId, connection.id),
        eq(crmNativeLinks.entityType, entityType),
        eq(crmNativeLinks.entityId, entityId)
      )
    )
    .limit(1);
  if (!link) return;

  try {
    await db
      .insert(crmOutboundWrites)
      .values({
        workspaceId,
        connectionId: connection.id,
        entityType,
        entityId,
        patch: owned,
        skoutChangedAt: changedAt,
        idempotencyKey: buildIdempotencyKey(connection.id, entityType, entityId, changedAt.toISOString()),
        status: "pending",
      })
      .onConflictDoNothing();
  } catch (err) {
    // Best-effort: the field edit itself already succeeded and returned to the caller by the
    // time this runs — a queuing failure shouldn't turn into a 500 for an otherwise-successful edit.
    log.error("failed to queue CRM outbound write", { err, workspaceId, entityType, entityId });
  }
}
