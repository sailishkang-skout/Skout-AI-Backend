import { Worker } from "bullmq";
import { createDb } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { loadEnv } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";
import { runWorkbookRunJob } from "../services/workbook-run.runner.js";
import { WORKBOOK_RUN_QUEUE, type WorkbookRunJobPayload } from "./workbook-run.queue.js";

const log = createLogger("workbook-run.worker");

export async function startWorkbookRunWorker(config: Env): Promise<() => Promise<void>> {
  if (!config.DATABASE_URL) {
    log.warn("Workbook run worker not started — DATABASE_URL not set");
    return async () => {};
  }

  if (!(await isRedisAvailable(config))) {
    log.warn("Workbook run worker not started — Redis unavailable");
    return async () => {};
  }

  const { db, sql } = createDb(config.DATABASE_URL);

  const worker = new Worker<WorkbookRunJobPayload>(
    WORKBOOK_RUN_QUEUE,
    async (job) => {
      const { runId, workspaceId } = job.data;
      log.info("Processing workbook run job", { runId, workspaceId, attempt: job.attemptsMade });
      await runWorkbookRunJob(db, config, runId, workspaceId);
    },
    {
      connection: redisBullMqConnection(config.REDIS_URL),
      concurrency: 2,
    }
  );

  worker.on("failed", (job, err) => {
    log.error("Workbook run job failed in worker", err, {
      runId: job?.data?.runId,
      workspaceId: job?.data?.workspaceId,
    });
  });

  log.info("Workbook run worker started", { queue: WORKBOOK_RUN_QUEUE });

  return async () => {
    await worker.close();
    await sql.end();
  };
}

async function main() {
  const config = loadEnv();
  const stop = await startWorkbookRunWorker(config);
  const shutdown = async () => {
    await stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isMain =
  process.argv[1]?.includes("workbook-run.worker") ||
  process.env.WORKBOOK_RUN_WORKER_STANDALONE === "true";

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
