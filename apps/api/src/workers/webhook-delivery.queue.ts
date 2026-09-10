import { Queue } from "bullmq";
import { injectTraceContext } from "@skout/observability";
import type { Env } from "../config/env.js";
import { redisBullMqConnection } from "../lib/redis.js";

export const WEBHOOK_DELIVERY_QUEUE = "skout-webhook-delivery";

export interface WebhookDeliveryJobPayload {
  deliveryId: string;
  endpointId: string;
  url: string;
  secret: string;
  workspaceId: string;
  eventType: string;
  eventId: string;
  attempt: number;
  payload: Record<string, unknown>;
  /** §11.3 Observability — W3C trace-context propagation, same pattern as list-score.queue.ts. Preserved unchanged across retry re-enqueues (see webhook-delivery.worker.ts) so a retried delivery still correlates back to the original triggering request. */
  traceContext?: Record<string, string>;
}

let queue: Queue<WebhookDeliveryJobPayload> | null = null;

export function getWebhookDeliveryQueue(config: Env): Queue<WebhookDeliveryJobPayload> {
  if (!queue) {
    queue = new Queue<WebhookDeliveryJobPayload>(WEBHOOK_DELIVERY_QUEUE, {
      connection: redisBullMqConnection(config.REDIS_URL),
      defaultJobOptions: {
        // BullMQ retries are disabled — the worker handles its own retry
        // scheduling so each attempt gets its own DB delivery record.
        attempts: 1,
        removeOnComplete: 500,
        removeOnFail: 200,
      },
    });
    queue.on("error", (err) => {
      console.warn(`[bullmq] ${WEBHOOK_DELIVERY_QUEUE} queue error:`, err.message);
    });
  }
  return queue;
}

export async function enqueueWebhookDelivery(
  config: Env,
  payload: WebhookDeliveryJobPayload,
  delayMs = 0
): Promise<void> {
  const q = getWebhookDeliveryQueue(config);
  await q.add(
    "webhook:deliver",
    { ...payload, traceContext: payload.traceContext ?? injectTraceContext() },
    { delay: Math.max(0, delayMs) }
  );
}
