import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo } from "@skout/db";
import { createLogger } from "@skout/observability";
import { HttpError } from "@skout/auth";
import type { Env } from "../config/env.js";
import { fetchHubSpotPropertyNames, type HubSpotRateLimitState } from "./hubspot.client.js";
import { getResolvedCrmMapping } from "./crm-mapping.service.js";
import { alertDay, crmProviderLabel, notifyCrmAdmins } from "./crm-alerts.service.js";

const { crmConnections, crmSyncCheckpoints, crmOutboundWrites, crmConflicts, auditLogs } = schema;
const log = createLogger("crm-observability");

export interface CrmHealthCheckResult {
  connected: boolean;
  provider: string;
  authStatus: "connected" | "needs_reauth" | "disconnected";
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

  // An expired access token is normal (it lasts 30 minutes and is refreshed on use); only a
  // rejected refresh (needs_reauth) means the admin must reconnect.
  const authStatus: CrmHealthCheckResult["authStatus"] =
    connection.status === "needs_reauth" ? "needs_reauth" : connection.status === "connected" ? "connected" : "disconnected";

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

  // Rate-limit state as last recorded on the connection by whichever process hit it.
  const stored = ((connection.settings ?? {}) as Record<string, any>).rateLimit as
    | { lastRateLimitedAt?: string | null; limitedUntil?: string | null; retryAfterMs?: number | null }
    | undefined;
  const rateLimitState: HubSpotRateLimitState | null = stored
    ? {
        isRateLimited: Boolean(stored.limitedUntil && new Date(stored.limitedUntil).getTime() > Date.now()),
        lastRateLimitedAt: stored.lastRateLimitedAt ?? null,
        limitedUntil: stored.limitedUntil ?? null,
        retryAfterMs: stored.retryAfterMs ?? null,
      }
    : null;

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
  /** One record's history. */
  entityId?: string;
  limit?: number;
  offset?: number;
}

/** lastError values of writes the outbound worker held back for a conflict. */
export const REPLAY_REFUSED_ERRORS = ["conflict_hubspot_newer", "blocked_by_pending_conflict"];

/**
 * Lists per-record outbound writes (history & DLQ) with filtering and pagination.
 */
export async function listCrmOutboundWrites(
  db: Db,
  workspaceId: string,
  opts: ListOutboundWritesOptions = {}
) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  const conditions = [eq(crmOutboundWrites.workspaceId, workspaceId)];
  if (opts.entityId) {
    conditions.push(eq(crmOutboundWrites.entityId, opts.entityId));
  }
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
    throw new HttpError(`Outbound write ${writeId} not found`, 404);
  }

  if (write.status !== "failed") {
    throw new HttpError(`Only failed writes can be replayed (current status: ${write.status})`, 409);
  }
  // A write held back by a conflict would only be held back again: the conflict queue decides it.
  if (write.lastError && REPLAY_REFUSED_ERRORS.includes(write.lastError)) {
    throw new HttpError(`This write was held back by a conflict (${write.lastError}); resolve it in the conflict queue`, 409);
  }

  // Back to pending, only if still failed: two replays at once queue it once. Replaying is safe:
  // the push is a PATCH of the same values, so it creates nothing twice.
  const reset = await db
    .update(crmOutboundWrites)
    .set({
      status: "pending",
      attemptCount: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(and(eq(crmOutboundWrites.id, write.id), eq(crmOutboundWrites.status, "failed")))
    .returning({ id: crmOutboundWrites.id });
  if (reset.length === 0) {
    throw new HttpError(`Outbound write ${writeId} was already replayed`, 409);
  }

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
  _config: Env,
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
    log.warn("CRM schema drift detected", { workspaceId, provider, entityType, missingFields });

    const providerLabel = crmProviderLabel(provider);
    try {
      // Once a day per set of missing fields, until the mapping or the provider is fixed.
      await notifyCrmAdmins(db, {
        workspaceId,
        type: "crm_schema_drift",
        title: `${providerLabel} Schema Drift Alert`,
        body: `Mapping for ${entityType} expects external field(s): ${missingFields.join(", ")}, which were not found in ${providerLabel}'s current schema. Those fields are not synced until the mapping is updated.`,
        dedupeKey: `drift:${workspaceId}:${provider}:${entityType}:${[...missingFields].sort().join(",")}:${alertDay()}`,
      });
    } catch (notifErr) {
      log.warn("Failed sending schema drift notifications", { notifErr, workspaceId });
    }

    return { driftDetected: true, missingFields };
  }

  return {
    driftDetected: false,
    missingFields: [],
  };
}

/** Checks both HubSpot object types against the portal's live property list. */
export async function checkHubSpotSchemaDrift(
  db: Db,
  config: Env,
  workspaceId: string,
  accessToken: string
): Promise<Record<"contact" | "deal", SchemaDriftResult>> {
  const [contactProps, dealProps] = await Promise.all([
    fetchHubSpotPropertyNames(accessToken, "contacts"),
    fetchHubSpotPropertyNames(accessToken, "deals"),
  ]);
  return {
    contact: await detectSchemaDrift(db, config, workspaceId, "hubspot", "contact", contactProps),
    deal: await detectSchemaDrift(db, config, workspaceId, "hubspot", "deal", dealProps),
  };
}
