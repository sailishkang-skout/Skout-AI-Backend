import { Worker } from "bullmq";
import { createDb } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { loadEnv } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";
import { runListScoreJob } from "../services/list-score.runner.js";
import { LIST_SCORE_QUEUE, type ListScoreJobPayload } from "./list-score.queue.js";

const log = createLogger("list-score.worker");

export async function startListScoreWorker(config: Env): Promise<() => Promise<void>> {
  if (!config.DATABASE_URL) {
    log.warn("List score worker not started — DATABASE_URL not set");
    return async () => {};
  }

  if (!(await isRedisAvailable(config))) {
    log.warn("List score worker not started — Redis unavailable");
    return async () => {};
  }

  const { db, sql } = createDb(config.DATABASE_URL);

  const worker = new Worker<ListScoreJobPayload>(
    LIST_SCORE_QUEUE,
    async (job) => {
      const { jobId, workspaceId, listId } = job.data;
      log.info("Processing list score job", { jobId, workspaceId, listId, attempt: job.attemptsMade });
      await runListScoreJob(db, config, jobId, workspaceId, listId);
    },
    {
      connection: redisBullMqConnection(config.REDIS_URL),
      concurrency: 2,
    }
  );

  worker.on("failed", (job, err) => {
    log.error("List score job failed in worker", err, {
      jobId: job?.data?.jobId,
      workspaceId: job?.data?.workspaceId,
    });
  });

  log.info("List score worker started", { queue: LIST_SCORE_QUEUE });

  return async () => {
    await worker.close();
    await sql.end();
  };
}

async function main() {
  const config = loadEnv();
  const stop = await startListScoreWorker(config);
  const shutdown = async () => {
    await stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isMain =
  process.argv[1]?.includes("list-score.worker") ||
  process.env.LIST_SCORE_WORKER_STANDALONE === "true";

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
