import { Worker, Queue } from "bullmq";
import { eq } from "drizzle-orm";
import { createDb, schema, scopedTo } from "@skout/db";
import { claimNext, reclaimExpiredLeases, recordResult, LeaseLostError } from "@skout/shared";
import { createLogger, withSpan } from "@skout/observability";
import type { Env } from "../config/env.js";
import { loadEnv } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";
import { ensureFreshTokens, createDefaultCredentialsStore } from "../services/crm-export.runner.js";
import { isHubSpotRetryableError, updateHubSpotContact, updateHubSpotDeal } from "../services/hubspot.client.js";

const log = createLogger("crm-outbound-write.worker");

const QUEUE_NAME = "crm-outbound-write";
const LEASE_MS = 60_000;
const MAX_PER_TICK = 25;
const WORKER_ID = `crm-outbound-write-${process.pid}`;

type Db = ReturnType<typeof createDb>["db"];

const CONTACT_FIELD_TO_HUBSPOT: Record<string, string> = {
  firstName: "firstname",
  lastName: "lastname",
  email: "email",
  phone: "phone",
  title: "jobtitle",
};
const DEAL_FIELD_TO_HUBSPOT: Record<string, string> = {
  name: "dealname",
  amount: "amount",
};

function toHubSpotProperties(entityType: string, patch: Record<string, unknown>): Record<string, string> {
  const map = entityType === "contact" ? CONTACT_FIELD_TO_HUBSPOT : DEAL_FIELD_TO_HUBSPOT;
  const props: Record<string, string> = {};
  for (const [field, value] of Object.entries(patch)) {
    const hsProp = map[field];
    if (hsProp && value != null) props[hsProp] = String(value);
  }
  return props;
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

    // Reverse manual-wins: if the provider's own value changed more recently than the Skout
    // edit that queued this write, skip the push rather than overwrite a newer provider-side edit.
    if (link.externalUpdatedAt && link.externalUpdatedAt > claimed.skoutChangedAt) {
      await recordResult(db, crmOutboundWrites, claimed.id, WORKER_ID, {
        status: "failed",
        lastError: "conflict_hubspot_newer",
      });
      return "conflict";
    }

    const credentialsStore = createDefaultCredentialsStore(config);
    const tokens = await ensureFreshTokens(db, config, credentialsStore, claimed.workspaceId);
    const properties = toHubSpotProperties(claimed.entityType, claimed.patch as Record<string, unknown>);

    if (claimed.entityType === "contact") {
      await updateHubSpotContact(tokens.accessToken, link.externalId, properties);
    } else {
      await updateHubSpotDeal(tokens.accessToken, link.externalId, properties);
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
    await recordResult(db, crmOutboundWrites, claimed.id, WORKER_ID, {
      status: "failed",
      lastError: err instanceof Error ? err.message : String(err),
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
