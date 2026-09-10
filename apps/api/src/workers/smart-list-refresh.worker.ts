import { Worker } from "bullmq";
import { context as otelContext } from "@opentelemetry/api";
import { createDb } from "@skout/db";
import { createLogger, extractTraceContext, withSpan } from "@skout/observability";
import type { Env } from "../config/env.js";
import { loadEnv } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";
import { runSmartListRefreshJob } from "../services/smart-list-refresh.runner.js";
import {
  SMART_LIST_REFRESH_QUEUE,
  type SmartListRefreshJobPayload,
} from "./smart-list-refresh.queue.js";

const log = createLogger("smart-list-refresh.worker");

export async function startSmartListRefreshWorker(config: Env): Promise<() => Promise<void>> {
  if (!config.DATABASE_URL) {
    log.warn("Smart list refresh worker not started — DATABASE_URL not set");
    return async () => {};
  }

  if (!(await isRedisAvailable(config))) {
    log.warn("Smart list refresh worker not started — Redis unavailable");
    return async () => {};
  }

  const { db, sql } = createDb(config.DATABASE_URL);

  const worker = new Worker<SmartListRefreshJobPayload>(
    SMART_LIST_REFRESH_QUEUE,
    async (job) => {
      const { jobId, workspaceId, listId, traceContext } = job.data;
      log.info("Processing smart list refresh job", {
        jobId,
        workspaceId,
        listId,
        attempt: job.attemptsMade,
      });

      // §11.3 — resume the enqueuing request's trace context, same pattern as list-score.worker.ts.
      const parentContext = extractTraceContext(traceContext);
      await otelContext.with(parentContext, () =>
        withSpan("smart-list-refresh.worker.process", () =>
          runSmartListRefreshJob(db, config, jobId, workspaceId, listId)
        )
      );
    },
    {
      connection: redisBullMqConnection(config.REDIS_URL),
      concurrency: 2,
    }
  );

  worker.on("failed", (job, err) => {
    log.error("Smart list refresh job failed in worker", err, {
      jobId: job?.data?.jobId,
      workspaceId: job?.data?.workspaceId,
    });
  });

  log.info("Smart list refresh worker started", { queue: SMART_LIST_REFRESH_QUEUE });

  return async () => {
    await worker.close();
    await sql.end();
  };
}

async function main() {
  const config = loadEnv();
  const stop = await startSmartListRefreshWorker(config);
  const shutdown = async () => {
    await stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isMain =
  process.argv[1]?.includes("smart-list-refresh.worker") ||
  process.env.SMART_LIST_REFRESH_WORKER_STANDALONE === "true";

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
