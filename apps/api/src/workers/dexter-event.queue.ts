import { Queue } from "bullmq";
import type { SkoutEvent } from "@skout/shared";
import type { Env } from "../config/env.js";
import { redisBullMqConnection } from "../lib/redis.js";

export const DEXTER_EVENT_QUEUE = "skout-dexter-event";

export interface DexterEventJobPayload {
  event: SkoutEvent;
}

let queue: Queue<DexterEventJobPayload> | null = null;

export function getDexterEventQueue(config: Env): Queue<DexterEventJobPayload> {
  if (!queue) {
    queue = new Queue<DexterEventJobPayload>(DEXTER_EVENT_QUEUE, {
      connection: redisBullMqConnection(config.REDIS_URL),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: 200,
        removeOnFail: 100,
      },
    });
    queue.on("error", (err) => {
      console.warn(`[bullmq] ${DEXTER_EVENT_QUEUE} queue error:`, err.message);
    });
  }
  return queue;
}

export async function enqueueDexterEventJob(config: Env, payload: DexterEventJobPayload): Promise<void> {
  const q = getDexterEventQueue(config);
  await q.add("process-event", payload, { jobId: payload.event.id });
}
