import { Worker } from "bullmq";
import { captureException, createLogger } from "@skout/observability";
import { parseCopsEvent, type CopsPhase1EventType } from "@skout/shared";
import { createDb, schema, type Db } from "@skout/db";
import { and, eq } from "drizzle-orm";
import type { Env } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";
import { DEXTER_EVENT_QUEUE, type DexterEventJobPayload } from "./dexter-event.queue.js";
import { incrJourneyMetric } from "../services/journey-metrics.js";
import {
  getCopsNotificationRecipients,
  resolveCopsNotificationRoles,
} from "../services/cops-notification-routing.js";
import { deliverNotificationChannels } from "../services/notifications.service.js";
import { projectCopsEventToTimelineRow } from "../services/cops-timeline.service.js";

const log = createLogger("dexter-event.worker");
const { copsNotificationRoutes, copsProcessedEvents, notifications } = schema;

/**
 * §7.3 — Dexter event spine consumer (BullMQ transport).
 */
export async function handleDexterEvent(
  event: DexterEventJobPayload["event"],
  db: Db | null,
  config?: Env
): Promise<void> {
  if ("event_type" in event) {
    const copsEvent = parseCopsEvent(event);
    if (!db) throw new Error("DATABASE_URL is required to process COPS events idempotently");
    const processing = await db.transaction(async (tx) => {
      const [claimed] = await tx
        .insert(copsProcessedEvents)
        .values({ consumer: "skout-dexter-event", eventId: copsEvent.event_id })
        .onConflictDoNothing()
        .returning({ eventId: copsProcessedEvents.eventId });
      if (!claimed) return { claimed: false, rows: [] };

      const [routeOverride] = await tx
        .select({ roleKeys: copsNotificationRoutes.roleKeys })
        .from(copsNotificationRoutes)
        .where(
          and(
            eq(copsNotificationRoutes.workspaceId, copsEvent.tenant_id),
            eq(copsNotificationRoutes.eventType, copsEvent.event_type)
          )
        )
        .limit(1);
      const roleKeys = resolveCopsNotificationRoles(
        copsEvent.event_type as CopsPhase1EventType,
        copsEvent.payload,
        routeOverride?.roleKeys
      );
      const recipientIds = await getCopsNotificationRecipients(tx, copsEvent.tenant_id, roleKeys);
      const title = `CustomerOps: ${copsEvent.event_type.replace(/([a-z])([A-Z])/g, "$1 $2")}`;
      const body = "A CustomerOps update is available for this record.";
      const rows = [];
      for (const userId of recipientIds) {
        const [row] = await tx
          .insert(notifications)
          .values({
            workspaceId: copsEvent.tenant_id,
            userId,
            type: `cops.${copsEvent.event_type}`,
            title,
            body,
            entityType: copsEvent.aggregate_type,
            entityId: copsEvent.aggregate_id,
            sourceEventId: copsEvent.event_id,
            deliveredChannels: ["in_app"],
          })
          .onConflictDoNothing()
          .returning();
        if (row) rows.push(row);
      }
      return { claimed: true, rows };
    });

    if (!processing.claimed) {
      log.info("recovered duplicate COPS event delivery", { eventId: copsEvent.event_id, type: copsEvent.event_type });
      if (!config) return;
      const existingRows = await db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.workspaceId, copsEvent.tenant_id),
            eq(notifications.sourceEventId, copsEvent.event_id)
          )
        );
      processing.rows = existingRows;
    }
    if (config) {
      for (const row of processing.rows) {
        await deliverNotificationChannels(db, config, {
          id: row.id,
          workspaceId: row.workspaceId,
          userId: row.userId,
          type: row.type,
          title: row.title,
          body: row.body,
          entityType: row.entityType,
          entityId: row.entityId,
          deliveredChannels: row.deliveredChannels as string[],
          readAt: row.readAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
        }, {
          eventId: copsEvent.event_id,
          correlationId: copsEvent.correlation_id,
          eventType: copsEvent.event_type,
        }, {
          retryFailedDelivery: true,
        });
      }
    }
    await projectCopsEventToTimelineRow(db, copsEvent);
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
      await handleDexterEvent(job.data.event, database?.db ?? null, config);
    },
    { connection: redisBullMqConnection(config.REDIS_URL), concurrency: 4 }
  );

  worker.on("failed", (job, err) => {
    log.error("dexter event job failed", { jobId: job?.id, err: err.message });
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      captureException(err, {
        module: "dexter-event.worker",
        jobId: job.id,
        eventId: "id" in job.data.event ? job.data.event.id : job.data.event.event_id,
        eventType: "type" in job.data.event ? job.data.event.type : job.data.event.event_type,
        attempts: job.attemptsMade,
      });
    }
  });

  log.info("dexter event worker started");
  return async () => {
    await worker.close();
    await database?.sql.end();
  };
}
