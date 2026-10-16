import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { getHubSpotRateLimitState, type HubSpotRateLimitState } from "./hubspot.client.js";
import { getResolvedCrmMapping } from "./crm-mapping.service.js";
import { createNotification } from "./notifications.service.js";
import { getCopsNotificationRecipients } from "./cops-notification-routing.js";

const { crmConnections, crmSyncCheckpoints, crmOutboundWrites, crmConflicts, auditLogs } = schema;
const log = createLogger("crm-observability");

export interface CrmHealthCheckResult {
  connected: boolean;
  provider: string;
  authStatus: "connected" | "needs_reauth" | "disconnected" | "expired";
  lastSyncAt: string | null;
  backlog: number;
  failedRecords: number;
  pendingConflicts: number;
  rateLimitState: HubSpotRateLimitState | null;
  checkpoints: Array<{
    entityType: string;
    lastRunStatus: string | null;
    lastRunCompletedAt: string | null;
    lastError: string | null;
    cursor: string | null;
  }>;
}

/**
 * Returns complete observability health for a CRM provider in the given workspace:
 * auth status, last sync timestamp, queue backlog count, failed records count,
 * pending conflict count, rate limit state, and entity checkpoints.
 */
export async function getCrmConnectorHealth(
  db: Db,
  workspaceId: string,
  provider: string
): Promise<CrmHealthCheckResult> {
  const [connection] = await db
    .select({
      id: crmConnections.id,
      status: crmConnections.status,
      tokenExpiresAt: crmConnections.tokenExpiresAt,
      settings: crmConnections.settings,
    })
    .from(crmConnections)
    .where(scopedTo(crmConnections, workspaceId, eq(crmConnections.provider, provider)))
    .limit(1);

  if (!connection || connection.status === "disconnected") {
    return {
      connected: false,
      provider,
      authStatus: "disconnected",
      lastSyncAt: null,
      backlog: 0,
      failedRecords: 0,
      pendingConflicts: 0,
      rateLimitState: null,
      checkpoints: [],
    };
  }

  // Derive granular authStatus
  let authStatus: "connected" | "needs_reauth" | "disconnected" | "expired" = "connected";
  if (connection.status === "needs_reauth") {
    authStatus = "needs_reauth";
  } else if (connection.tokenExpiresAt && new Date(connection.tokenExpiresAt).getTime() < Date.now()) {
    authStatus = "expired";
  } else if (connection.status === "connected") {
    authStatus = "connected";
  } else {
    authStatus = "disconnected";
  }

  // Fetch checkpoints
  const checkpointRows = await db
    .select({
      entityType: crmSyncCheckpoints.entityType,
      lastRunStatus: crmSyncCheckpoints.lastRunStatus,
      lastRunCompletedAt: crmSyncCheckpoints.lastRunCompletedAt,
      lastError: crmSyncCheckpoints.lastError,
      cursor: crmSyncCheckpoints.cursor,
    })
    .from(crmSyncCheckpoints)
    .where(scopedTo(crmSyncCheckpoints, workspaceId, eq(crmSyncCheckpoints.connectionId, connection.id)));

  // Derive lastSyncAt: latest successful run
  let latestSuccessMs = 0;
  for (const cp of checkpointRows) {
    if (cp.lastRunStatus === "succeeded" && cp.lastRunCompletedAt) {
      const ms = new Date(cp.lastRunCompletedAt).getTime();
      if (ms > latestSuccessMs) latestSuccessMs = ms;
    }
  }
  const lastSyncAt = latestSuccessMs > 0 ? new Date(latestSuccessMs).toISOString() : null;

  // Backlog: pending or leased outbound writes
  const [backlogRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(crmOutboundWrites)
    .where(
      and(
        eq(crmOutboundWrites.workspaceId, workspaceId),
        eq(crmOutboundWrites.connectionId, connection.id),
        inArray(crmOutboundWrites.status, ["pending", "leased"])
      )
    );

  // Failed records in outbound queue (DLQ)
  const [failedRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(crmOutboundWrites)
    .where(
      and(
        eq(crmOutboundWrites.workspaceId, workspaceId),
        eq(crmOutboundWrites.connectionId, connection.id),
        eq(crmOutboundWrites.status, "failed")
      )
    );

  // Pending conflicts
  const [conflictsRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(crmConflicts)
    .where(
      and(
        eq(crmConflicts.workspaceId, workspaceId),
        eq(crmConflicts.connectionId, connection.id),
        eq(crmConflicts.status, "pending")
      )
    );

  // Rate limit state (provider-specific)
  const rateLimitState = provider === "hubspot" ? getHubSpotRateLimitState() : null;

  return {
    connected: true,
    provider,
    authStatus,
    lastSyncAt,
    backlog: backlogRow?.count ?? 0,
    failedRecords: failedRow?.count ?? 0,
    pendingConflicts: conflictsRow?.count ?? 0,
    rateLimitState,
    checkpoints: checkpointRows.map((r) => ({
      entityType: r.entityType,
      lastRunStatus: r.lastRunStatus,
      lastRunCompletedAt: r.lastRunCompletedAt ? r.lastRunCompletedAt.toISOString() : null,
      lastError: r.lastError,
      cursor: r.cursor ? r.cursor.toISOString() : null,
    })),
  };
}

export interface ListOutboundWritesOptions {
  status?: string;
  entityType?: string;
  limit?: number;
  offset?: number;
}

/**
 * Lists per-record outbound writes (history & DLQ) with filtering and pagination.
 */
export async function listCrmOutboundWrites(
  db: Db,
  workspaceId: string,
  opts: ListOutboundWritesOptions = {}
) {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  const conditions = [eq(crmOutboundWrites.workspaceId, workspaceId)];
  if (opts.status) {
    conditions.push(eq(crmOutboundWrites.status, opts.status));
  }
  if (opts.entityType) {
    conditions.push(eq(crmOutboundWrites.entityType, opts.entityType));
  }

  const rows = await db
    .select()
    .from(crmOutboundWrites)
    .where(and(...conditions))
    .orderBy(desc(crmOutboundWrites.createdAt))
    .limit(limit)
    .offset(offset);

  return rows;
}

/**
 * Replays a failed outbound write from the Dead Letter Queue (DLQ).
 * Resets status to 'pending', attempt count to 0, clears lease and error, and creates an audit record.
 */
export async function replayCrmOutboundWrite(
  db: Db,
  workspaceId: string,
  writeId: string,
  actorId?: string
) {
  const [write] = await db
    .select()
    .from(crmOutboundWrites)
    .where(
      and(
        eq(crmOutboundWrites.workspaceId, workspaceId),
        eq(crmOutboundWrites.id, writeId)
      )
    )
    .limit(1);

  if (!write) {
    throw new Error(`Outbound write ${writeId} not found`);
  }

  if (write.status !== "failed") {
    throw new Error(`Only failed writes can be replayed (current status: ${write.status})`);
  }

  // Reset write in DLQ to pending
  await db
    .update(crmOutboundWrites)
    .set({
      status: "pending",
      attemptCount: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(crmOutboundWrites.id, write.id));

  // Audited replay
  try {
    await db.insert(auditLogs).values({
      workspaceId,
      actorType: actorId ? "user" : "system",
      actorId: actorId ?? null,
      action: "crm_outbound_write.replayed",
      entityType: write.entityType,
      entityId: write.entityId,
      beforeState: {
        writeId: write.id,
        status: write.status,
        attemptCount: write.attemptCount,
        lastError: write.lastError,
      },
      afterState: {
        writeId: write.id,
        status: "pending",
        attemptCount: 0,
      },
      reason: "Outbound write replayed from DLQ",
    });
  } catch (auditErr) {
    log.warn("Failed recording audit log for replayed outbound write", { auditErr, writeId: write.id });
  }

  log.info("CRM outbound write replayed from DLQ", {
    writeId: write.id,
    workspaceId,
    entityType: write.entityType,
    entityId: write.entityId,
  });

  return {
    ok: true,
    id: write.id,
    status: "pending",
    replayedAt: new Date().toISOString(),
  };
}

export interface SchemaDriftResult {
  driftDetected: boolean;
  missingFields: string[];
}

/**
 * Checks if the external provider properties list has drifted away from the current mapping schema.
 * If external fields mapped in Skout do not exist in the provider properties, raises an in-app alert
 * instead of silently dropping fields.
 */
export async function detectSchemaDrift(
  db: Db,
  config: Env,
  workspaceId: string,
  provider: string,
  entityType: "contact" | "deal",
  providerProperties: string[]
): Promise<SchemaDriftResult> {
  const mapping = await getResolvedCrmMapping(db, workspaceId, provider, entityType);
  const providerPropsSet = new Set(providerProperties.map((p) => p.toLowerCase()));

  const missingFields: string[] = [];
  for (const field of mapping.fields) {
    if (!providerPropsSet.has(field.externalField.toLowerCase())) {
      missingFields.push(field.externalField);
    }
  }

  if (missingFields.length > 0) {
    log.warn("CRM schema drift detected", {
      workspaceId,
      provider,
      entityType,
      missingFields,
    });

    const providerLabel = provider.charAt(0).toUpperCase() + provider.slice(1);
    const title = `${providerLabel} Schema Drift Alert`;
    const body = `Mapping for ${entityType} expects external field(s): ${missingFields.join(", ")}, which were not found in ${providerLabel}'s current schema. Please update your field mappings.`;

    try {
      await createNotification(db, config, {
        workspaceId,
        userId: null,
        type: "crm_schema_drift",
        title,
        body,
        entityType: "crm_connection",
        entityId: undefined,
      });

      const admins = await getCopsNotificationRecipients(db, workspaceId, ["admin", "owner"]);
      for (const adminId of admins) {
        await createNotification(db, config, {
          workspaceId,
          userId: adminId,
          type: "crm_schema_drift",
          title,
          body,
          entityType: "crm_connection",
          entityId: undefined,
        }).catch((err) => {
          log.warn("Failed creating user notification for schema drift", { err, adminId });
        });
      }
    } catch (notifErr) {
      log.warn("Failed sending schema drift notifications", { notifErr, workspaceId });
    }

    return {
      driftDetected: true,
      missingFields,
    };
  }

  return {
    driftDetected: false,
    missingFields: [],
  };
}
