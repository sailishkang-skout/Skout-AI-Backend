import { Worker } from "bullmq";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { redisBullMqConnection } from "../lib/redis.js";
import { DEXTER_EVENT_QUEUE, type DexterEventJobPayload } from "./dexter-event.queue.js";
import { incrJourneyMetric } from "../services/journey-metrics.js";

const log = createLogger("dexter-event.worker");

/**
 * §7.3 — Dexter event spine consumer (BullMQ transport).
 */
async function handleDexterEvent(event: DexterEventJobPayload["event"]): Promise<void> {
  switch (event.type) {
    case "icp.approved":
      incrJourneyMetric("icpApproved");
      break;
    case "tam.approved":
      incrJourneyMetric("tamApproved");
      break;
    case "regional_brief.approved":
      incrJourneyMetric("regionalBriefApproved");
      break;
    case "dexter.plan.proposed":
    case "dexter.plan.approved":
    case "dexter.action.executed":
    case "dexter.learning.approved":
      incrJourneyMetric("dexterPlanInvoke");
      break;
    default:
      break;
  }
  log.info("processed dexter spine event", { type: event.type, correlationId: event.correlationId });
}

export async function startDexterEventWorker(config: Env): Promise<() => Promise<void>> {
  if (!config.REDIS_URL) {
    log.warn("REDIS_URL unset — dexter event worker not started");
    return async () => {};
  }

  const worker = new Worker<DexterEventJobPayload>(
    DEXTER_EVENT_QUEUE,
    async (job) => {
      await handleDexterEvent(job.data.event);
    },
    { connection: redisBullMqConnection(config.REDIS_URL), concurrency: 4 }
  );

  worker.on("failed", (job, err) => {
    log.error("dexter event job failed", { jobId: job?.id, err: err.message });
  });

  log.info("dexter event worker started");
  return async () => {
    await worker.close();
  };
}
