import { Worker } from "bullmq";
import { context as otelContext } from "@opentelemetry/api";
import { createDb } from "@skout/db";
import { createLogger, extractTraceContext, withSpan } from "@skout/observability";
import type { Env } from "../config/env.js";
import { loadEnv } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";
import { runWorkspaceRescoreJob } from "../services/workspace-rescore.runner.js";
import {
  WORKSPACE_RESCORE_QUEUE,
  type WorkspaceRescoreJobPayload,
} from "./workspace-rescore.queue.js";

const log = createLogger("workspace-rescore.worker");

export async function startWorkspaceRescoreWorker(config: Env): Promise<() => Promise<void>> {
  if (!config.DATABASE_URL) {
    log.warn("Workspace rescore worker not started — DATABASE_URL not set");
    return async () => {};
  }

  if (!(await isRedisAvailable(config))) {
    log.warn("Workspace rescore worker not started — Redis unavailable");
    return async () => {};
  }

  const { db, sql } = createDb(config.DATABASE_URL);

  const worker = new Worker<WorkspaceRescoreJobPayload>(
    WORKSPACE_RESCORE_QUEUE,
    async (job) => {
      const { jobId, workspaceId, icpVersion, traceContext } = job.data;
      log.info("Processing workspace rescore job", {
        jobId,
        workspaceId,
        icpVersion,
        attempt: job.attemptsMade,
      });

      // §11.3 — resume the enqueuing request's trace context, same pattern as list-score.worker.ts.
      const parentContext = extractTraceContext(traceContext);
      await otelContext.with(parentContext, () =>
        withSpan("workspace-rescore.worker.process", () =>
          runWorkspaceRescoreJob(db, config, jobId, workspaceId, icpVersion)
        )
      );
    },
    {
      connection: redisBullMqConnection(config.REDIS_URL),
      concurrency: 1,
    }
  );

  worker.on("failed", (job, err) => {
    log.error("Workspace rescore job failed in worker", err, {
      jobId: job?.data?.jobId,
      workspaceId: job?.data?.workspaceId,
    });
  });

  log.info("Workspace rescore worker started", { queue: WORKSPACE_RESCORE_QUEUE });

  return async () => {
    await worker.close();
    await sql.end();
  };
}

async function main() {
  const config = loadEnv();
  const stop = await startWorkspaceRescoreWorker(config);
  const shutdown = async () => {
    await stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isMain =
  process.argv[1]?.includes("workspace-rescore.worker") ||
  process.env.WORKSPACE_RESCORE_WORKER_STANDALONE === "true";

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
