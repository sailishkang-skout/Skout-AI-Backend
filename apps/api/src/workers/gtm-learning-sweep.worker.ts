import { Worker, Queue } from "bullmq";
import { createDb } from "@skout/db";
import { createLogger, withSpan } from "@skout/observability";
import type { Env } from "../config/env.js";
import { loadEnv } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";
import { runGtmLearningAggregation } from "../services/gtm-learning.service.js";

const log = createLogger("gtm-learning-sweep.worker");

const QUEUE_NAME = "gtm-learning-sweep";

/** §8.15 SP-10 — periodically re-runs the GTM-learning cross-tab aggregation across every
 * workspace, keeping gtm_learning_outcomes current as new touchpoints execute and as
 * replies/meetings/deals land against enrollments already in the table. */
export async function startGtmLearningSweepWorker(config: Env) {
  if (!config.DATABASE_URL) {
    log.warn("DATABASE_URL not set — GTM-learning sweep worker disabled");
    return () => Promise.resolve();
  }

  if (!(await isRedisAvailable(config))) {
    log.warn("Redis unavailable — GTM-learning sweep worker disabled");
    return () => Promise.resolve();
  }

  const connection = redisBullMqConnection(config.REDIS_URL);
  const queue = new Queue(QUEUE_NAME, { connection });

  const cronExpression = `*/${config.GTM_LEARNING_SWEEP_INTERVAL_MINUTES} * * * *`;
  await queue.upsertJobScheduler(
    "gtm-learning-sweep-all",
    { pattern: cronExpression },
    { name: "gtm-learning-sweep-all", data: {} }
  );

  const { db } = createDb(config.DATABASE_URL);

  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      // Self-triggered on a cron schedule; root span (no upstream trace exists).
      await withSpan("gtm-learning-sweep.tick", async () => {
        const { rowCount } = await runGtmLearningAggregation(db);
        log.info(`GTM-learning aggregation refreshed ${rowCount} touchpoint row(s)`);
      });
    },
    { connection, concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    log.error("GTM-learning sweep job failed", { jobId: job?.id, err });
  });

  log.info(`GTM-learning sweep worker started (cron: ${cronExpression})`);

  return async () => {
    await worker.close();
    await queue.close();
  };
}

if (
  process.argv[1]?.endsWith("gtm-learning-sweep.worker.ts") ||
  process.argv[1]?.endsWith("gtm-learning-sweep.worker.js")
) {
  const config = loadEnv();
  startGtmLearningSweepWorker(config).then(() => {
    log.info("GTM-learning sweep worker running standalone");
  });
}
