import { and, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { isCrmSyncOptedIn } from "./crm-opt-in.service.js";
import { syncHubSpotNativeOrThrow } from "./crm-hubspot-native-sync.service.js";

const { crmConnections, crmSyncCheckpoints, auditLogs } = schema;
const log = createLogger("crm-initial-import");

export interface InitialImportOptions {
  resetCheckpoint?: boolean;
  maxBatches?: number;
  batchSize?: number;
  actorId?: string;
}

export interface InitialImportResult {
  completed: boolean;
  batchesRun: number;
  contacts: {
    pulled: number;
    created: number;
    updated: number;
    skipped: number;
  };
  deals: {
    pulled: number;
    created: number;
    updated: number;
    skipped: number;
  };
}

/**
 * Runs a resumable, paged initial import from an external CRM connector.
 * Validates workspace opt-in status (ADR 0014), optionally resets checkpoint,
 * and iterates in bounded batches until the external historical record is caught up.
 */
export async function runInitialCrmImport(
  db: Db,
  config: Env,
  workspaceId: string,
  provider: string,
  opts: InitialImportOptions = {}
): Promise<InitialImportResult> {
  const [connection] = await db
    .select({
      id: crmConnections.id,
      status: crmConnections.status,
      settings: crmConnections.settings,
    })
    .from(crmConnections)
    .where(scopedTo(crmConnections, workspaceId, eq(crmConnections.provider, provider)))
    .limit(1);

  if (!connection) {
    throw new Error(`No CRM connection found for ${provider}`);
  }

  if (connection.status !== "connected") {
    throw new Error(`CRM connection is not connected (status: ${connection.status})`);
  }

  // Enforce opt-in per ADR 0014
  if (!isCrmSyncOptedIn(connection.settings)) {
    throw new Error("CRM sync is not enabled for this workspace. Opt-in is required under ADR 0014.");
  }

  // If reset requested, clear checkpoint cursor to start from beginning of time
  if (opts.resetCheckpoint) {
    await db
      .update(crmSyncCheckpoints)
      .set({
        cursor: null,
        lastRunStatus: "never_run",
        updatedAt: new Date(),
      })
      .where(scopedTo(crmSyncCheckpoints, workspaceId, eq(crmSyncCheckpoints.connectionId, connection.id)));
  }

  const maxBatches = opts.maxBatches ?? 10;
  const batchSize = opts.batchSize ?? 100;

  const totalContacts = { pulled: 0, created: 0, updated: 0, skipped: 0 };
  const totalDeals = { pulled: 0, created: 0, updated: 0, skipped: 0 };

  let batchesRun = 0;
  let completed = false;

  for (let i = 0; i < maxBatches; i++) {
    batchesRun++;

    const outcome = await syncHubSpotNativeOrThrow(db, config, workspaceId, {
      maxContacts: batchSize,
      maxDeals: batchSize,
      includeDeals: true,
    });

    totalContacts.pulled += outcome.contacts.pulled;
    totalContacts.created += outcome.contacts.created;
    totalContacts.updated += outcome.contacts.updated;
    totalContacts.skipped += outcome.contacts.skipped;

    if (outcome.deals) {
      totalDeals.pulled += outcome.deals.pulled;
      totalDeals.created += outcome.deals.created;
      totalDeals.updated += outcome.deals.updated;
      totalDeals.skipped += outcome.deals.skipped;
    }

    const contactsDone = outcome.contacts.pulled < batchSize;
    const dealsDone = !outcome.deals || outcome.deals.pulled < batchSize;

    if (contactsDone && dealsDone) {
      completed = true;
      break;
    }
  }

  try {
    await db.insert(auditLogs).values({
      workspaceId,
      actorType: opts.actorId ? "user" : "system",
      actorId: opts.actorId ?? null,
      action: "crm_initial_import.completed",
      entityType: "crm_connection",
      entityId: connection.id,
      afterState: {
        completed,
        batchesRun,
        contacts: totalContacts,
        deals: totalDeals,
      },
      reason: "Initial CRM import batch executed",
    });
  } catch (auditErr) {
    log.warn("Failed recording audit log for initial import", { auditErr, connectionId: connection.id });
  }

  log.info("CRM initial import finished", {
    workspaceId,
    provider,
    completed,
    batchesRun,
    contacts: totalContacts,
    deals: totalDeals,
  });

  return {
    completed,
    batchesRun,
    contacts: totalContacts,
    deals: totalDeals,
  };
}

export interface ScheduledPollResult {
  totalEligible: number;
  synced: number;
  failed: number;
  results: Array<{
    workspaceId: string;
    provider: string;
    success: boolean;
    error?: string;
  }>;
}

/**
 * Runs a scheduled incremental poll for all connected and opted-in CRM workspaces.
 * Called on a periodic timer when webhooks are unavailable or as an integrity backstop.
 */
export async function runScheduledCrmPoll(db: Db, config: Env): Promise<ScheduledPollResult> {
  const activeConnections = await db
    .select({
      id: crmConnections.id,
      workspaceId: crmConnections.workspaceId,
      provider: crmConnections.provider,
      settings: crmConnections.settings,
    })
    .from(crmConnections)
    .where(eq(crmConnections.status, "connected"));

  // Filter for opted-in workspaces
  const eligible = activeConnections.filter((c) => isCrmSyncOptedIn(c.settings));

  const results: ScheduledPollResult["results"] = [];
  let synced = 0;
  let failed = 0;

  for (const conn of eligible) {
    try {
      if (conn.provider === "hubspot") {
        await syncHubSpotNativeOrThrow(db, config, conn.workspaceId, {
          maxContacts: 100,
          maxDeals: 100,
        });
      }
      synced++;
      results.push({ workspaceId: conn.workspaceId, provider: conn.provider, success: true });
    } catch (err) {
      failed++;
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.warn("Scheduled CRM poll failed for connection", {
        err,
        connectionId: conn.id,
        workspaceId: conn.workspaceId,
      });
      results.push({
        workspaceId: conn.workspaceId,
        provider: conn.provider,
        success: false,
        error: errorMsg,
      });
    }
  }

  log.info("Scheduled CRM poll completed", {
    totalEligible: eligible.length,
    synced,
    failed,
  });

  return {
    totalEligible: eligible.length,
    synced,
    failed,
    results,
  };
}
