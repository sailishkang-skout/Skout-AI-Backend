import { Worker, Queue } from "bullmq";
import { eq } from "drizzle-orm";
import { createDb, schema, scopedTo } from "@skout/db";
import { claimNext, reclaimExpiredLeases, recordResult, LeaseLostError } from "@skout/shared";
import { createLogger, withSpan } from "@skout/observability";
import type { Env } from "../config/env.js";
import { loadEnv } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";
import { ensureFreshTokens, createDefaultCredentialsStore } from "../services/crm-export.runner.js";
import {
  isHubSpotMissingScopeError,
  isHubSpotRetryableError,
  fetchHubSpotObjectProperties,
  updateHubSpotContact,
  updateHubSpotDeal,
} from "../services/hubspot.client.js";
import {
  applyOutboundMapping,
  DEFAULT_HUBSPOT_CONTACT_MAPPING,
  DEFAULT_HUBSPOT_DEAL_MAPPING,
  getResolvedCrmMapping,
  type CrmObjectMapping,
} from "../services/crm-mapping.service.js";
import { evaluateFieldConflict, getPendingConflictFields, recordCrmConflict } from "../services/crm-conflict.service.js";
import { getCrmSyncScope } from "../services/crm-opt-in.service.js";
import { persistHubSpotRateLimit } from "../services/crm-alerts.service.js";

const log = createLogger("crm-outbound-write.worker");

const QUEUE_NAME = "crm-outbound-write";
const LEASE_MS = 60_000;
const MAX_PER_TICK = 25;
const WORKER_ID = `crm-outbound-write-${process.pid}`;

type Db = ReturnType<typeof createDb>["db"];

function toHubSpotProperties(
  entityType: string,
  patch: Record<string, unknown>,
  mapping?: CrmObjectMapping
): Record<string, string> {
  if (mapping) {
    const { properties } = applyOutboundMapping(mapping, patch);
    return properties;
  }
  const defaultMapping = entityType === "contact" ? DEFAULT_HUBSPOT_CONTACT_MAPPING : DEFAULT_HUBSPOT_DEAL_MAPPING;
  return applyOutboundMapping(defaultMapping, patch).properties;
}

/**
 * §8.12 Task ADI-10 — claims and processes one queued outbound write. Returns "pushed",
 * "conflict" (HubSpot changed more recently — the reverse of the inbound manual-wins rule, so
 * Skout does not overwrite it), or null when there was nothing pending to claim.
 */
export async function processNextCrmOutboundWrite(db: Db, config: Env): Promise<"pushed" | "conflict" | null> {
  const { crmOutboundWrites, crmNativeLinks } = schema;

  const claimed = await claimNext(db, crmOutboundWrites, WORKER_ID, LEASE_MS);
  if (!claimed) return null;

  try {
    const [link] = await db
      .select()
      .from(crmNativeLinks)
      .where(
        scopedTo(
          crmNativeLinks,
          claimed.workspaceId,
          eq(crmNativeLinks.connectionId, claimed.connectionId),
          eq(crmNativeLinks.entityType, claimed.entityType),
          eq(crmNativeLinks.entityId, claimed.entityId)
        )
      )
      .limit(1);

    if (!link) {
      await recordResult(db, crmOutboundWrites, claimed.id, WORKER_ID, {
        status: "failed",
        lastError: "no_native_link",
      });
      return "pushed";
    }

    const entityType = claimed.entityType as "contact" | "deal";

    // ADR 0014: a connection that has sync turned off (or this object type out of scope) pushes nothing.
    const scope = await getCrmSyncScope(db, claimed.workspaceId, "hubspot");
    if (!scope?.enabled || !(entityType === "contact" ? scope.contacts : scope.deals)) {
      await recordResult(db, crmOutboundWrites, claimed.id, WORKER_ID, { status: "failed", lastError: "sync_disabled" });
      return "pushed";
    }

    const mapping = await getResolvedCrmMapping(db, claimed.workspaceId, "hubspot", entityType).catch(() => undefined);
    const patch: Record<string, unknown> = { ...(claimed.patch as Record<string, unknown>) };
    let held: "blocked_by_pending_conflict" | "conflict_hubspot_newer" | null = null;

    // A field with a pending conflict is not overwritten in either direction until it is resolved.
    const pending = await getPendingConflictFields(db, claimed.workspaceId, claimed.connectionId, entityType, claimed.entityId);
    for (const field of Object.keys(patch)) {
      if (pending.has(field)) {
        delete patch[field];
        held = "blocked_by_pending_conflict";
      }
    }

    const credentialsStore = createDefaultCredentialsStore(config);
    const tokens = await ensureFreshTokens(db, config, credentialsStore, claimed.workspaceId);
    try {
      // The provider changed the record after this Skout edit: each field's conflict policy
      // decides, against the provider's current value.
      if (link.externalUpdatedAt && link.externalUpdatedAt > claimed.skoutChangedAt && Object.keys(patch).length > 0) {
        const fieldMap = (mapping ?? (entityType === "contact" ? DEFAULT_HUBSPOT_CONTACT_MAPPING : DEFAULT_HUBSPOT_DEAL_MAPPING)).fields;
        const externalOf = (field: string) => fieldMap.find((f) => f.internalField === field);
        const current = await fetchHubSpotObjectProperties(
          tokens.accessToken,
          entityType === "contact" ? "contacts" : "deals",
          link.externalId,
          Object.keys(patch).map((f) => externalOf(f)?.externalField ?? f)
        );
        for (const [field, value] of Object.entries(patch)) {
          const fm = externalOf(field);
          const externalValue = current[fm?.externalField ?? field] ?? null;
          const decision = evaluateFieldConflict({
            fieldName: field,
            skoutValue: value,
            externalValue,
            skoutUpdatedAt: claimed.skoutChangedAt,
            externalUpdatedAt: link.externalUpdatedAt,
            policy: fm?.conflictPolicy ?? "most_recent",
            isFieldProtected: fm?.isProtected,
          });
          if (decision.action === "keep_skout") continue;
          delete patch[field];
          held = held ?? "conflict_hubspot_newer";
          if (decision.action === "manual_review") {
            held = "blocked_by_pending_conflict";
            await recordCrmConflict(db, {
              workspaceId: claimed.workspaceId,
              connectionId: claimed.connectionId,
              entityType,
              entityId: claimed.entityId,
              externalId: link.externalId,
              fieldName: field,
              skoutValue: value != null ? String(value) : null,
              externalValue,
              skoutUpdatedAt: claimed.skoutChangedAt,
              externalUpdatedAt: link.externalUpdatedAt,
              policy: "manual_review",
            });
          }
        }
      }

      if (Object.keys(patch).length === 0) {
        await recordResult(db, crmOutboundWrites, claimed.id, WORKER_ID, { status: "failed", lastError: held ?? "nothing_to_push" });
        return "conflict";
      }

      const properties = toHubSpotProperties(claimed.entityType, patch, mapping);
      if (entityType === "contact") {
        await updateHubSpotContact(tokens.accessToken, link.externalId, properties);
      } else {
        await updateHubSpotDeal(tokens.accessToken, link.externalId, properties);
      }
    } finally {
      await persistHubSpotRateLimit(db, claimed.connectionId, tokens.accessToken).catch(() => undefined);
    }

    await recordResult(db, crmOutboundWrites, claimed.id, WORKER_ID, { status: "succeeded" });
    return "pushed";
  } catch (err) {
    if (err instanceof LeaseLostError) {
      log.info("outbound write lease lost — another worker already claimed it", { id: claimed.id });
      return "pushed";
    }
    if (isHubSpotRetryableError(err)) {
      // Leave it claimed — reclaimExpiredLeases requeues it (or fails it past MAX_ATTEMPTS) once
      // the lease expires, which is this library's retry/backoff mechanism.
      log.warn("outbound write failed with a retryable error, leaving for lease-expiry retry", {
        id: claimed.id,
        err,
      });
      return "pushed";
    }
    // A missing OAuth scope (e.g. crm.objects.deals.write) is never going to succeed on retry —
    // record a stable sentinel instead of HubSpot's raw error text so the sync-status API can
    // surface an actionable "reconnect HubSpot" message rather than a generic failure.
    await recordResult(db, crmOutboundWrites, claimed.id, WORKER_ID, {
      status: "failed",
      lastError: isHubSpotMissingScopeError(err)
        ? "missing_scope_crm_write"
        : err instanceof Error
          ? err.message
          : String(err),
    }).catch(() => {
      /* lease may already be lost; nothing more to do */
    });
    return "pushed";
  }
}

export async function startCrmOutboundWriteWorker(config: Env) {
  if (!config.DATABASE_URL) {
    log.warn("DATABASE_URL not set — CRM outbound write worker disabled");
    return () => Promise.resolve();
  }
  if (!(await isRedisAvailable(config))) {
    log.warn("Redis unavailable — CRM outbound write worker disabled");
    return () => Promise.resolve();
  }

  const connection = redisBullMqConnection(config.REDIS_URL);
  const queue = new Queue(QUEUE_NAME, { connection });

  const cronExpression = `*/${config.CRM_OUTBOUND_WRITE_SWEEP_INTERVAL_MINUTES} * * * *`;
  await queue.upsertJobScheduler(
    "crm-outbound-write-all",
    { pattern: cronExpression },
    { name: "crm-outbound-write-all", data: {} }
  );

  const { db } = createDb(config.DATABASE_URL);
  const { crmOutboundWrites } = schema;

  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      await withSpan("crm-outbound-write.tick", async () => {
        let pushed = 0;
        for (let i = 0; i < MAX_PER_TICK; i++) {
          const outcome = await processNextCrmOutboundWrite(db, config);
          if (!outcome) break;
          pushed++;
        }
        const { requeuedIds, failedIds } = await reclaimExpiredLeases(db, crmOutboundWrites);
        if (pushed > 0 || requeuedIds.length > 0 || failedIds.length > 0) {
          log.info("CRM outbound write tick complete", {
            processed: pushed,
            requeued: requeuedIds.length,
            failed: failedIds.length,
          });
        }
      });
    },
    { connection, concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    log.error("CRM outbound write job failed", { jobId: job?.id, err });
  });

  log.info(`CRM outbound write worker started (cron: ${cronExpression})`);

  return async () => {
    await worker.close();
    await queue.close();
  };
}

if (
  process.argv[1]?.endsWith("crm-outbound-write.worker.ts") ||
  process.argv[1]?.endsWith("crm-outbound-write.worker.js")
) {
  const config = loadEnv();
  startCrmOutboundWriteWorker(config).then(() => {
    log.info("CRM outbound write worker running standalone");
  });
}
