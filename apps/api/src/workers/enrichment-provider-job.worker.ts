import { Queue, Worker } from "bullmq";
import { createDb, type Db } from "@skout/db";
import { createLogger, withSpan } from "@skout/observability";
import type { Env } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";
import { recoverProviderJobs, runProviderJob } from "../services/enrichment/provider-jobs.service.js";
import {
  ENRICHMENT_PROVIDER_JOB_QUEUE,
  enqueueEnrichmentProviderJob,
  type EnrichmentProviderJobPayload,
} from "./enrichment-provider-job.queue.js";

const log = createLogger("enrichment-provider-job.worker");

const RECOVERY_QUEUE = "skout-enrichment-provider-job-recovery";
const RECOVERY_EVERY_MS = 30_000;

/** One recovery pass: put back what a dead worker left, then hand every due job to `dispatch`. */
export async function recoverAndDispatch(db: Db, dispatch: (jobId: string) => Promise<void>): Promise<void> {
  const result = await recoverProviderJobs(db);
  if (result.requeued || result.failed || result.abandonedWaterfall) {
    log.warn("enrichment jobs recovered", { requeued: result.requeued, failed: result.failed, abandonedWaterfall: result.abandonedWaterfall });
  }
  for (const jobId of result.due) await dispatch(jobId);
}

/**
 * ENR-04 — runs provider enrichment jobs and recovers the ones a restart interrupted.
 *
 * With Redis: a BullMQ worker runs jobs and a repeating recovery job re-queues anything left
 * behind. Without Redis (local development): the same recovery pass runs on a timer and runs
 * due jobs in this process, so a queued job is never simply forgotten.
 */
export async function startEnrichmentProviderJobWorker(config: Env): Promise<() => Promise<void>> {
  if (!config.DATABASE_URL) {
    log.warn("DATABASE_URL not set — enrichment provider job worker disabled");
    return async () => {};
  }
  const { db, sql } = createDb(config.DATABASE_URL);

  const runOne = async (jobId: string) => {
    const outcome = await withSpan("enrichment-provider-job.run", () => runProviderJob(db, config, jobId));
    if (outcome.state === "retry_scheduled") {
      // If this hand-off is lost, the recovery pass finds the job once it is due.
      await enqueueEnrichmentProviderJob(config, jobId, outcome.retryAt.getTime() - Date.now());
    }
  };

  if (!(await isRedisAvailable(config))) {
    log.warn("Redis unavailable — enrichment provider jobs run in-process on a timer");
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        await recoverAndDispatch(db, runOne);
      } catch (err) {
        log.error("enrichment provider job pass failed", err);
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(tick, RECOVERY_EVERY_MS);
    timer.unref();
    void tick();
    return async () => {
      clearInterval(timer);
      await sql.end();
    };
  }

  const connection = redisBullMqConnection(config.REDIS_URL);
  const worker = new Worker<EnrichmentProviderJobPayload>(
    ENRICHMENT_PROVIDER_JOB_QUEUE,
    async (job) => runOne(job.data.jobId),
    { connection, concurrency: 2 }
  );
  worker.on("failed", (job, err) => log.error("enrichment provider job message failed", err, { jobId: job?.data?.jobId }));

  const recoveryQueue = new Queue(RECOVERY_QUEUE, { connection });
  await recoveryQueue.upsertJobScheduler(
    "enrichment-provider-job-recovery",
    { every: RECOVERY_EVERY_MS },
    { name: "enrichment-provider-job-recovery", data: {}, opts: { removeOnComplete: true, removeOnFail: 10 } }
  );
  const dispatch = async (jobId: string) => {
    await enqueueEnrichmentProviderJob(config, jobId);
  };
  const recoveryWorker = new Worker(
    RECOVERY_QUEUE,
    async () => withSpan("enrichment-provider-job.recovery", () => recoverAndDispatch(db, dispatch)),
    { connection }
  );
  recoveryWorker.on("failed", (_job, err) => log.error("enrichment provider job recovery failed", err));

  // Jobs interrupted by the restart that just happened are picked up now, not in 30 seconds.
  await recoverAndDispatch(db, dispatch).catch((err) => log.error("enrichment provider job start-up recovery failed", err));
  log.info("Enrichment provider job worker started", { queue: ENRICHMENT_PROVIDER_JOB_QUEUE });

  return async () => {
    await worker.close();
    await recoveryWorker.close();
    await recoveryQueue.close();
    await sql.end();
  };
}
