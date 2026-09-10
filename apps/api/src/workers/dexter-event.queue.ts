import { Queue } from "bullmq";
import type { SkoutEvent } from "@skout/shared";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { redisBullMqConnection } from "../lib/redis.js";

export const DEXTER_EVENT_QUEUE = "skout-dexter-event";

export interface DexterEventJobPayload {
  event: SkoutEvent;
}

/**
 * How long `enqueueDexterEventJob` will wait for `Queue.add()` before giving up and
 * returning. Matches `lib/redis.ts`'s own `connectTimeout: 2_000` — without Redis
 * running, `Queue.add()` never rejects on its own (ioredis queues the command
 * offline and keeps retrying the connection), so this is raced against a timer to
 * keep `emitSkoutEvent` callers (proposeDexterPlan/approveDexterPlan/invokeDexterPlan,
 * etc.) from blocking indefinitely when Redis is unreachable.
 */
const ENQUEUE_TIMEOUT_MS = 2_000;

const log = createLogger("dexter-event.queue");

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
  const addPromise = getDexterEventQueue(config)
    .add("process-event", payload, { jobId: payload.event.id })
    .then(() => "added" as const)
    .catch((err: unknown) => {
      log.warn("dexter event enqueue failed", { eventType: payload.event.type, eventId: payload.event.id, err });
      return "failed" as const;
    });

  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ENQUEUE_TIMEOUT_MS);
  });

  const outcome = await Promise.race([addPromise, timeoutPromise]);
  clearTimeout(timer!);

  if (outcome === "timeout") {
    log.warn("dexter event enqueue timed out — Redis unreachable or slow; event dropped", {
      eventType: payload.event.type,
      eventId: payload.event.id,
      timeoutMs: ENQUEUE_TIMEOUT_MS,
    });
  }
}
