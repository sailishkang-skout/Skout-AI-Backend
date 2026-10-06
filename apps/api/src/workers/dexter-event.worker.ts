import { Worker } from "bullmq";
import { createLogger } from "@skout/observability";
import { parseCopsEvent } from "@skout/shared";
import { createDb, schema, type Db } from "@skout/db";
import { eq } from "drizzle-orm";
import type { Env } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";
import { DEXTER_EVENT_QUEUE, type DexterEventJobPayload } from "./dexter-event.queue.js";
import { incrJourneyMetric } from "../services/journey-metrics.js";

const log = createLogger("dexter-event.worker");

/**
 * §7.3 — Dexter event spine consumer (BullMQ transport).
 */
export async function handleDexterEvent(event: DexterEventJobPayload["event"], db: Db | null): Promise<void> {
  if ("event_type" in event) {
    const copsEvent = parseCopsEvent(event);
    if (!db) throw new Error("DATABASE_URL is required to process COPS events idempotently");
    const [claimed] = await db
      .insert(schema.copsProcessedEvents)
      .values({ consumer: "skout-dexter-event", eventId: copsEvent.event_id })
      .onConflictDoNothing()
      .returning({ eventId: schema.copsProcessedEvents.eventId });
    if (!claimed) {
      log.info("ignored duplicate COPS event", { eventId: copsEvent.event_id, type: copsEvent.event_type });
      return;
    }
    log.info("processed COPS event on the existing dexter event spine", {
      type: copsEvent.event_type,
      eventId: copsEvent.event_id,
      correlationId: copsEvent.correlation_id,
    });
    return;
  }

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
    case "dexter.plan.invoked":
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
  if (!config.REDIS_URL || !(await isRedisAvailable(config))) {
    log.warn("REDIS_URL unset or unavailable — dexter event worker not started");
    return async () => {};
  }

  const database = config.DATABASE_URL ? createDb(config.DATABASE_URL) : null;
  const worker = new Worker<DexterEventJobPayload>(
    DEXTER_EVENT_QUEUE,
    async (job) => {
      await handleDexterEvent(job.data.event, database?.db ?? null);
    },
    { connection: redisBullMqConnection(config.REDIS_URL), concurrency: 4 }
  );

  worker.on("failed", (job, err) => {
    log.error("dexter event job failed", { jobId: job?.id, err: err.message });
  });

  log.info("dexter event worker started");
  return async () => {
    await worker.close();
    await database?.sql.end();
  };
}
