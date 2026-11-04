import { Worker, Queue } from "bullmq";
import { createDb } from "@skout/db";
import { createLogger, withSpan } from "@skout/observability";
import type { Env } from "../config/env.js";
import { loadEnv } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";
import { runScheduledCrmPoll } from "../services/crm-initial-import.service.js";

const log = createLogger("crm-sync-poll.worker");

const QUEUE_NAME = "crm-sync-poll";

/**
 * COPS-09 — the incremental CRM poll. Every CRM_SYNC_POLL_SWEEP_INTERVAL_MINUTES it polls each
 * connected, opted-in connection whose own poll interval (settings.pollIntervalMinutes, default
 * 30) has passed. Same shape as the outbound-write worker: one BullMQ job scheduler, concurrency 1.
 */
export async function startCrmSyncPollWorker(config: Env) {
  if (!config.DATABASE_URL) {
    log.warn("DATABASE_URL not set — CRM sync poll worker disabled");
    return () => Promise.resolve();
  }
  if (!(await isRedisAvailable(config))) {
    log.warn("Redis unavailable — CRM sync poll worker disabled");
    return () => Promise.resolve();
  }

  const connection = redisBullMqConnection(config.REDIS_URL);
  const queue = new Queue(QUEUE_NAME, { connection });

  const cronExpression = `*/${config.CRM_SYNC_POLL_SWEEP_INTERVAL_MINUTES} * * * *`;
  await queue.upsertJobScheduler("crm-sync-poll-all", { pattern: cronExpression }, { name: "crm-sync-poll-all", data: {} });

  const { db } = createDb(config.DATABASE_URL);

  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      await withSpan("crm-sync-poll.tick", async () => {
        const result = await runScheduledCrmPoll(db, config);
        if (result.totalEligible > 0) {
          log.info("CRM sync poll tick complete", { polled: result.totalEligible, synced: result.synced, failed: result.failed });
        }
      });
    },
    { connection, concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    log.error("CRM sync poll job failed", { jobId: job?.id, err });
  });

  log.info(`CRM sync poll worker started (cron: ${cronExpression})`);

  return async () => {
    await worker.close();
    await queue.close();
  };
}

if (process.argv[1]?.endsWith("crm-sync-poll.worker.ts") || process.argv[1]?.endsWith("crm-sync-poll.worker.js")) {
  const config = loadEnv();
  startCrmSyncPollWorker(config).then(() => {
    log.info("CRM sync poll worker running standalone");
  });
}
