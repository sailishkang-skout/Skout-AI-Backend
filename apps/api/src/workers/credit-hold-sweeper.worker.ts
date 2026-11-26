import { Worker, Queue } from "bullmq";
import { createDb, type Db } from "@skout/db";
import { createLogger, withSpan } from "@skout/observability";
import type { Env } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";
import { releaseExpiredHolds } from "../services/api-credits.service.js";

const log = createLogger("credit-hold-sweeper.worker");

const QUEUE_NAME = "credit-hold-sweeper";
/** Every minute, so an expired hold is freed at most about a minute after its 15-minute expiry. */
const CRON = "* * * * *";

/** PAPI-032: releases credit holds past their expiry and logs each one. */
export async function runCreditHoldSweep(db: Db, now: Date = new Date()) {
  let total = 0;
  for (;;) {
    const released = await releaseExpiredHolds(db, now);
    for (const h of released) {
      log.warn("released an expired credit hold", {
        holdId: h.id,
        workspaceId: h.workspaceId,
        apiKeyId: h.apiKeyId,
        requestId: h.requestId,
        amount: h.amount,
        expiredAt: h.expiresAt.toISOString(),
      });
    }
    total += released.length;
    if (released.length < 500) break;
  }
  if (total > 0) log.info("credit hold sweep finished", { released: total });
  return total;
}

export async function startCreditHoldSweeperWorker(config: Env) {
  if (!config.DATABASE_URL) {
    log.warn("DATABASE_URL not set — credit hold sweeper disabled");
    return () => Promise.resolve();
  }
  if (!(await isRedisAvailable(config))) {
    log.warn("Redis unavailable — credit hold sweeper disabled");
    return () => Promise.resolve();
  }
  const connection = redisBullMqConnection(config.REDIS_URL);
  const queue = new Queue(QUEUE_NAME, { connection });
  await queue.upsertJobScheduler("credit-hold-sweeper-minutely", { pattern: CRON }, { name: "credit-hold-sweeper-minutely", data: {} });
  const { db } = createDb(config.DATABASE_URL);
  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      await withSpan("credit-hold-sweeper.tick", async () => {
        await runCreditHoldSweep(db);
      });
    },
    { connection, concurrency: 1 }
  );
  worker.on("failed", (job, err) => log.error("Credit hold sweep failed", { jobId: job?.id, err }));
  log.info(`Credit hold sweeper started (cron: ${CRON})`);
  return async () => {
    await worker.close();
    await queue.close();
  };
}
