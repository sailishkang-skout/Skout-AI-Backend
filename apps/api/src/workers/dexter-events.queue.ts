import { Queue } from "bullmq";
import type { SkoutEvent } from "@skout/shared";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { redisBullMqConnection } from "../lib/redis.js";

export const DEXTER_EVENTS_QUEUE = "skout-dexter-events";

/**
 * How long `enqueueDexterEvent` will wait for `Queue.add()` before giving up and
 * returning. Chosen to match `lib/redis.ts`'s own `connectTimeout: 2_000` so a down
 * Redis surfaces on roughly the same timescale everywhere in this codebase.
 */
const ENQUEUE_TIMEOUT_MS = 2_000;

const log = createLogger("dexter-events.queue");

let queue: Queue<SkoutEvent<Record<string, unknown>>> | null = null;

export function getDexterEventsQueue(config: Env): Queue<SkoutEvent<Record<string, unknown>>> {
  if (!queue) {
    queue = new Queue(DEXTER_EVENTS_QUEUE, {
      connection: redisBullMqConnection(config.REDIS_URL),
      defaultJobOptions: {
        // handleDexterEvent has no idempotency/dedup logic (no check for an existing
        // plan before creating one, no dedup on event id or event+trigger) — do not
        // raise attempts above 1 without adding dedup, or retries will silently
        // create duplicate dexter_plans rows and duplicate enroll() invocations.
        attempts: 1,
        removeOnComplete: 500,
        removeOnFail: 500,
      },
    });
    queue.on("error", (err) => {
      console.error("dexter-events queue error", err);
      log.warn("dexter-events queue error", { message: err.message });
    });
  }
  return queue;
}

/**
 * Enqueue a Dexter event onto the event spine.
 *
 * Every call races `Queue.add()` against a short timer instead of gating on a
 * cached "is Redis up" check. Two reasons:
 *
 *  1. Without Redis running, `Queue.add()` never rejects — ioredis queues the
 *     command offline and its default retry strategy keeps retrying the
 *     connection forever, so the promise never settles on its own.
 *  2. A cached availability probe (e.g. `isRedisAvailable`, which this module
 *     used previously) is a one-time startup gate by design — it latches to
 *     `false` on the first failure and never re-checks. On this hot path
 *     (called from every `proposeDexterPlan`/`invokeDexterPlan`/`approveVersion`)
 *     that would mean one transient Redis blip permanently silences the event
 *     spine for the rest of the process's life, with no way to recover.
 *
 * Racing the real operation against a timer avoids both problems: every call
 * gets a fresh attempt (no permanent latch), and the caller is never blocked
 * longer than `ENQUEUE_TIMEOUT_MS` regardless of Redis's state. Callers already
 * wrap this in try/catch as a best-effort side effect; a timeout or failure here
 * is logged (not thrown) so a dark event spine is observable rather than silent.
 */
export async function enqueueDexterEvent(
  config: Env,
  event: SkoutEvent<Record<string, unknown>>,
  delayMs = 0
): Promise<void> {
  const addPromise = getDexterEventsQueue(config)
    .add(event.type, event, { delay: delayMs })
    .then(() => "added" as const)
    .catch((err) => {
      log.warn("dexter event enqueue failed", { eventType: event.type, eventId: event.id, err });
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
      eventType: event.type,
      eventId: event.id,
      timeoutMs: ENQUEUE_TIMEOUT_MS,
    });
  }
}
