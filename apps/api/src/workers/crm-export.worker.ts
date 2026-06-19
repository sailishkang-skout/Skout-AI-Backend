import { Worker } from "bullmq";
import { createDb } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { loadEnv } from "../config/env.js";
import {
  createDefaultCredentialsStore,
  runHubSpotExportJob,
} from "../services/crm-export.runner.js";
import { CRM_EXPORT_QUEUE, type CrmExportJobPayload } from "./crm-export.queue.js";

const log = createLogger("crm-export.worker");

function redisConnection(redisUrl: string) {
  const parsed = new URL(redisUrl);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || "6379"),
    password: parsed.password || undefined,
    ...(parsed.protocol === "rediss:" ? { tls: {} } : {}),
  };
}

export async function startCrmExportWorker(config: Env): Promise<() => Promise<void>> {
  if (!config.DATABASE_URL) {
    log.warn("CRM export worker not started — DATABASE_URL not set");
    return async () => {};
  }

  const { db, sql } = createDb(config.DATABASE_URL);

  const credentialsStore = createDefaultCredentialsStore(config);

  const worker = new Worker<CrmExportJobPayload>(
    CRM_EXPORT_QUEUE,
    async (job) => {
      const { jobId, workspaceId, listId } = job.data;
      log.info("Processing HubSpot export", { jobId, workspaceId, listId, attempt: job.attemptsMade });
      await runHubSpotExportJob(db, config, credentialsStore, jobId, workspaceId, listId);
    },
    {
      connection: redisConnection(config.REDIS_URL),
      concurrency: 2,
    }
  );

  worker.on("failed", (job, err) => {
    log.error("CRM export job failed in worker", err, {
      jobId: job?.data?.jobId,
      workspaceId: job?.data?.workspaceId,
    });
  });

  log.info("CRM export worker started", { queue: CRM_EXPORT_QUEUE });

  return async () => {
    await worker.close();
    await sql.end();
  };
}

/** Standalone entrypoint: `node dist/workers/crm-export.worker.js` */
async function main() {
  const config = loadEnv();
  const stop = await startCrmExportWorker(config);
  const shutdown = async () => {
    await stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isMain =
  process.argv[1]?.includes("crm-export.worker") ||
  process.env.CRM_EXPORT_WORKER_STANDALONE === "true";

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
