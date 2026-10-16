import { and, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { isCrmSyncOptedIn } from "./crm-opt-in.service.js";
import { syncHubSpotNativeOrThrow } from "./crm-hubspot-native-sync.service.js";
import { createDefaultCredentialsStore, ensureFreshTokens } from "./crm-export.runner.js";
import { checkHubSpotSchemaDrift } from "./crm-observability.service.js";
import { alertDay, mergeConnectionSettings, notifyCrmAdmins, persistHubSpotRateLimit } from "./crm-alerts.service.js";
import { HttpError } from "@skout/auth";

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
    throw new HttpError(`No CRM connection found for ${provider}`, 404);
  }

  if (connection.status !== "connected") {
    throw new HttpError(`CRM connection is not connected (status: ${connection.status})`, 409);
  }

  // Enforce opt-in per ADR 0014
  if (!isCrmSyncOptedIn(connection.settings)) {
    throw new HttpError("crm_sync_not_enabled", 409);
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

/** Consecutive failed polls before the admins are alerted (then at most once a day). */
export const POLL_FAILURE_ALERT_THRESHOLD = 3;
const SCHEMA_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Whether a connection's poll interval has passed since its last poll. */
export function isPollDue(settings: Record<string, any>, now: Date): boolean {
  const minutes = typeof settings.pollIntervalMinutes === "number" && settings.pollIntervalMinutes > 0 ? settings.pollIntervalMinutes : 30;
  const last = typeof settings.lastPolledAt === "string" ? Date.parse(settings.lastPolledAt) : NaN;
  return Number.isNaN(last) || now.getTime() - last >= minutes * 60_000;
}

/**
 * Runs the incremental poll for every connected, opted-in CRM connection whose poll interval has
 * passed (the crm-sync-poll worker calls this every few minutes). Webhooks bring changes sooner;
 * this is the backstop that catches anything a webhook missed. Per connection it also checks the
 * mapping against the provider's live schema once a day, and after POLL_FAILURE_ALERT_THRESHOLD
 * failures in a row it alerts the admins.
 */
export async function runScheduledCrmPoll(db: Db, config: Env, now: Date = new Date()): Promise<ScheduledPollResult> {
  const activeConnections = await db
    .select({
      id: crmConnections.id,
      workspaceId: crmConnections.workspaceId,
      provider: crmConnections.provider,
      settings: crmConnections.settings,
    })
    .from(crmConnections)
    .where(eq(crmConnections.status, "connected"));

  const eligible = activeConnections.filter(
    (c) => c.provider === "hubspot" && isCrmSyncOptedIn(c.settings) && isPollDue((c.settings ?? {}) as Record<string, any>, now)
  );

  const results: ScheduledPollResult["results"] = [];
  let synced = 0;
  let failed = 0;

  for (const conn of eligible) {
    const settings = (conn.settings ?? {}) as Record<string, any>;
    try {
      await syncHubSpotNativeOrThrow(db, config, conn.workspaceId, { maxContacts: 100, maxDeals: 100 });

      const tokens = await ensureFreshTokens(db, config, createDefaultCredentialsStore(config), conn.workspaceId);
      const lastCheck = typeof settings.lastSchemaCheckAt === "string" ? Date.parse(settings.lastSchemaCheckAt) : NaN;
      const schemaCheck: Record<string, unknown> = {};
      if (Number.isNaN(lastCheck) || now.getTime() - lastCheck >= SCHEMA_CHECK_INTERVAL_MS) {
        await checkHubSpotSchemaDrift(db, config, conn.workspaceId, tokens.accessToken).catch((err) =>
          log.warn("CRM schema drift check failed", { err, connectionId: conn.id })
        );
        schemaCheck.lastSchemaCheckAt = now.toISOString();
      }
      await persistHubSpotRateLimit(db, conn.id, tokens.accessToken).catch(() => undefined);
      await mergeConnectionSettings(db, conn.id, { lastPolledAt: now.toISOString(), pollFailures: 0, lastPollError: null, ...schemaCheck });

      synced++;
      results.push({ workspaceId: conn.workspaceId, provider: conn.provider, success: true });
    } catch (err) {
      failed++;
      const errorMsg = err instanceof Error ? err.message : String(err);
      const failures = (typeof settings.pollFailures === "number" ? settings.pollFailures : 0) + 1;
      log.warn("Scheduled CRM poll failed for connection", { err, connectionId: conn.id, workspaceId: conn.workspaceId, failures });
      await mergeConnectionSettings(db, conn.id, { lastPolledAt: now.toISOString(), pollFailures: failures, lastPollError: errorMsg.slice(0, 500) }).catch(
        () => undefined
      );
      // An expired grant has its own alert (markConnectionNeedsReauth).
      if (failures >= POLL_FAILURE_ALERT_THRESHOLD && !/needs_reauth/.test(errorMsg)) {
        await notifyCrmAdmins(db, {
          workspaceId: conn.workspaceId,
          type: "crm_sync_failing",
          title: "HubSpot sync is failing",
          body: `The last ${failures} HubSpot syncs failed: ${errorMsg.slice(0, 300)}. Nothing is lost: the next successful sync continues from the last checkpoint. See CRM health in Settings > Integrations.`,
          connectionId: conn.id,
          dedupeKey: `poll-failing:${conn.id}:${alertDay(now)}`,
        }).catch((notifyErr) => log.warn("Failed alerting admins of failing CRM sync", { notifyErr, connectionId: conn.id }));
      }
      results.push({ workspaceId: conn.workspaceId, provider: conn.provider, success: false, error: errorMsg });
    }
  }

  log.info("Scheduled CRM poll completed", { totalEligible: eligible.length, synced, failed });

  return { totalEligible: eligible.length, synced, failed, results };
}
