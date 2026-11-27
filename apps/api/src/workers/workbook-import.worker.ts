import { Queue, Worker } from "bullmq";
import { createDb } from "@skout/db";
import { createLogger, withSpan } from "@skout/observability";
import type { Env } from "../config/env.js";
import { loadEnv } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";
import { describeFailure, runImportJob, sweepImports, type ImportJob } from "../services/workbook-import-runner.js";
import { importStorage } from "../services/workbook-import-storage.js";
import { prospectDirectory } from "../services/prospect-directory.js";
import { crmAccess } from "../services/workbook-crm-access.js";
import { WORKBOOK_IMPORT_QUEUE, closeWorkbookImportQueue, workbookImportQueue } from "./workbook-import.queue.js";

const log = createLogger("workbook-import.worker");

const SWEEP_QUEUE = "skout-workbook-import-sweep";
const SWEEP_EVERY_MS = 5 * 60 * 1000;
/** Imports run beside API requests, so only a couple at once; a second slot keeps one large file from blocking others. */
const CONCURRENCY = 2;

export async function startWorkbookImportWorker(config: Env): Promise<() => Promise<void>> {
  if (!config.DATABASE_URL) {
    log.warn("Workbook import worker not started — DATABASE_URL not set");
    return async () => {};
  }
  const storage = importStorage(config);
  if (!storage) {
    log.warn("Workbook import worker not started — no storage for import files (EXPORTS_BUCKET)");
    return async () => {};
  }
  if (!(await isRedisAvailable(config))) {
    log.warn("Workbook import worker not started — Redis unavailable");
    return async () => {};
  }

  const { db, sql } = createDb(config.DATABASE_URL);
  const directory = prospectDirectory(config);
  const crm = crmAccess(db, config);
  const connection = redisBullMqConnection(config.REDIS_URL);

  const worker = new Worker<ImportJob>(
    WORKBOOK_IMPORT_QUEUE,
    async (job) => {
      const { importId, workspaceId } = job.data;
      log.info("Processing workbook import", { importId, workspaceId, attempt: job.attemptsMade });
      const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      await withSpan("workbook-import.worker.process", () => runImportJob(db, storage, importId, lastAttempt, directory, crm));
    },
    { connection, concurrency: CONCURRENCY }
  );
  worker.on("failed", (job, err) => {
    log.error("Workbook import job failed in worker", err, { importId: job?.data?.importId, workspaceId: job?.data?.workspaceId });
  });

  const sweepQueue = new Queue(SWEEP_QUEUE, { connection });
  await sweepQueue.upsertJobScheduler("workbook-import-sweep-all", { every: SWEEP_EVERY_MS }, { name: "sweep", data: {}, opts: { removeOnComplete: 10, removeOnFail: 10 } });
  const sweeper = new Worker(
    SWEEP_QUEUE,
    async () => {
      const result = await withSpan("workbook-import.sweep", () => sweepImports(db, storage, workbookImportQueue(config)));
      if (result.expired || result.requeued || result.gaveUp || result.cleaned) log.info("Workbook import sweep", { ...result });
    },
    { connection, concurrency: 1 }
  );
  sweeper.on("failed", (_job, err) => log.error("Workbook import sweep failed", undefined, { failure: describeFailure(err) }));

  log.info("Workbook import worker started", { queue: WORKBOOK_IMPORT_QUEUE });

  return async () => {
    await worker.close();
    await sweeper.close();
    await sweepQueue.close();
    await closeWorkbookImportQueue();
    await sql.end();
  };
}

async function main() {
  const config = loadEnv();
  const stop = await startWorkbookImportWorker(config);
  const shutdown = async () => {
    await stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isMain = process.argv[1]?.includes("workbook-import.worker") || process.env.WORKBOOK_IMPORT_WORKER_STANDALONE === "true";

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
