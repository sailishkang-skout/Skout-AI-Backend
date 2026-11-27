import { Worker, Queue } from "bullmq";
import { createDb, maintainPublicApiTables, type Db } from "@skout/db";
import { createLogger, withSpan } from "@skout/observability";
import type { Env } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";

const log = createLogger("public-api-maintenance.worker");

const QUEUE_NAME = "public-api-maintenance";
/** Hourly at :20 UTC, so 24-hour idempotency records never outlive 25 hours. */
const CRON = "20 * * * *";

/**
 * PAPI-012 housekeeping for the public API tables: request-log partitions are created ahead and
 * dropped after 90 days; idempotency records are purged after 24 hours. Runs even while
 * PUBLIC_API_ENABLED is off, so the tables are ready when the flag is turned on.
 */
export async function runPublicApiMaintenance(db: Db, now: Date = new Date()) {
  const result = await maintainPublicApiTables(db, now);
  log.info("public API maintenance finished", {
    partitionsCreated: result.partitionsCreated,
    partitionsDropped: result.partitionsDropped,
    idempotencyPurged: result.idempotencyPurged,
  });
  return result;
}

export async function startPublicApiMaintenanceWorker(config: Env) {
  if (!config.DATABASE_URL) {
    log.warn("DATABASE_URL not set — public API maintenance worker disabled");
    return () => Promise.resolve();
  }
  if (!(await isRedisAvailable(config))) {
    log.warn("Redis unavailable — public API maintenance worker disabled");
    return () => Promise.resolve();
  }
  const connection = redisBullMqConnection(config.REDIS_URL);
  const queue = new Queue(QUEUE_NAME, { connection });
  await queue.upsertJobScheduler("public-api-maintenance-hourly", { pattern: CRON }, { name: "public-api-maintenance-hourly", data: {} });
  const { db } = createDb(config.DATABASE_URL);
  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      await withSpan("public-api-maintenance.tick", async () => {
        await runPublicApiMaintenance(db);
      });
    },
    { connection, concurrency: 1 }
  );
  worker.on("failed", (job, err) => log.error("Public API maintenance job failed", { jobId: job?.id, err }));
  log.info(`Public API maintenance worker started (cron: ${CRON})`);
  return async () => {
    await worker.close();
    await queue.close();
  };
}
