import { Queue } from "bullmq";
import type { SkoutEvent } from "@skout/shared";
import type { Env } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";

export const DEXTER_EVENTS_QUEUE = "skout-dexter-events";

let queue: Queue<SkoutEvent<Record<string, unknown>>> | null = null;

export function getDexterEventsQueue(config: Env): Queue<SkoutEvent<Record<string, unknown>>> {
  if (!queue) {
    queue = new Queue(DEXTER_EVENTS_QUEUE, {
      connection: redisBullMqConnection(config.REDIS_URL),
      defaultJobOptions: { removeOnComplete: 500, removeOnFail: 500 },
    });
    queue.on("error", (err) => {
      console.error("dexter-events queue error", err);
    });
  }
  return queue;
}

/**
 * Enqueue a Dexter event onto the event spine.
 *
 * Guarded by `isRedisAvailable` before touching BullMQ: without Redis running,
 * `Queue.add()` does not reject — ioredis queues the command offline and its
 * default retry strategy keeps retrying the connection forever, so the promise
 * never settles. Every caller of this function treats it as a best-effort,
 * non-blocking side effect (wrapped in try/catch), so it must resolve promptly
 * — with or without Redis — rather than hang the caller indefinitely.
 */
export async function enqueueDexterEvent(
  config: Env,
  event: SkoutEvent<Record<string, unknown>>,
  delayMs = 0
): Promise<void> {
  if (!(await isRedisAvailable(config))) return;
  await getDexterEventsQueue(config).add(event.type, event, { delay: delayMs });
}
