import { Worker } from "bullmq";
import { createDb, type Db } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { loadEnv } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";
import { runPublicApiJob } from "../public-api/endpoints/emails.js";
import { PUBLIC_API_JOBS_QUEUE, type PublicApiJobPayload } from "./public-api-jobs.queue.js";

const log = createLogger("public-api-jobs.worker");

/** PAPI-058: runs public API batch jobs (emails.verify batches today). */
export async function startPublicApiJobsWorker(config: Env): Promise<() => Promise<void>> {
  if (!config.DATABASE_URL) {
    log.warn("Public API jobs worker not started — DATABASE_URL not set");
    return async () => {};
  }
  if (!(await isRedisAvailable(config))) {
    log.warn("Public API jobs worker not started — Redis unavailable (batch jobs then run in the API process)");
    return async () => {};
  }
  const { db, sql } = createDb(config.DATABASE_URL);
  const worker = new Worker<PublicApiJobPayload>(
    PUBLIC_API_JOBS_QUEUE,
    async (job) => {
      await runPublicApiJob(db as Db, config, job.data.jobId);
    },
    { connection: redisBullMqConnection(config.REDIS_URL), concurrency: 2 }
  );
  worker.on("failed", (job, err) => log.error("Public API job failed in worker", err, { jobId: job?.data?.jobId }));
  log.info("Public API jobs worker started", { queue: PUBLIC_API_JOBS_QUEUE });
  return async () => {
    await worker.close();
    await sql.end();
  };
}

async function main() {
  const stop = await startPublicApiJobsWorker(loadEnv());
  const shutdown = async () => {
    await stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1]?.includes("public-api-jobs.worker") || process.env.PUBLIC_API_JOBS_WORKER_STANDALONE === "true") {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
