import { Queue } from "bullmq";
import { createEvent, type CreateEventInput, type SkoutEvent } from "@skout/shared";
import { schema, type Db } from "@skout/db";
import { serviceLog } from "../lib/obs.js";
import type { Env } from "../config/env.js";
import { redisBullMqConnection } from "../lib/redis.js";

const log = serviceLog("skout-event");

/** Same limit as apps/api: how long to wait for Redis before giving up on the enqueue. */
const ENQUEUE_TIMEOUT_MS = 2_000;

/**
 * §7.3 — apps/crm's producer side of the Dexter event spine. Enqueues onto the exact same
 * BullMQ queue name ("skout-dexter-event") that apps/api's dexter-event.queue.ts / .worker.ts
 * already produce/consume, so meeting.completed and opportunity.updated (both CRM-owned
 * entities) join the same spine without apps/crm needing its own consumer.
 *
 * Scoped deliberately: unlike apps/api's emitSkoutEvent, this does NOT also fan out to
 * outbound webhooks — apps/crm has no webhookEndpoints lookup/dispatch of its own, and building
 * one is out of scope for wiring up the event spine. Webhook parity for CRM-originated spine
 * events is a known follow-up, not a regression — most non-email sequence touchpoints (LinkedIn/
 * WhatsApp/Call) don't dispatch webhooks today either.
 */
let queue: Queue<{ event: SkoutEvent }> | null = null;

function getQueue(config: Env): Queue<{ event: SkoutEvent }> | null {
  if (!config.REDIS_URL) return null;
  if (!queue) {
    queue = new Queue<{ event: SkoutEvent }>("skout-dexter-event", {
      connection: redisBullMqConnection(config.REDIS_URL),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: 200,
        removeOnFail: 100,
      },
    });
    queue.on("error", (err) => log.warn("skout-dexter-event queue error", { err: err.message }));
  }
  return queue;
}

export async function emitSkoutEvent<T extends Record<string, unknown>>(
  db: Db,
  config: Env,
  input: CreateEventInput<T>
): Promise<SkoutEvent<T>> {
  const event = createEvent(input);
  await db
    .insert(schema.skoutEvents)
    .values({
      id: event.id,
      workspaceId: event.tenantId,
      type: event.type,
      aggregateId: event.aggregateId,
      correlationId: event.correlationId,
      data: event.data,
      occurredAt: new Date(event.occurredAt),
    })
    .catch((err: unknown) => {
      log.warn("failed to persist skout event to the event log", {
        type: event.type,
        err: err instanceof Error ? err.message : String(err),
      });
    });

  const q = getQueue(config);
  if (!q) {
    log.warn("REDIS_URL unset — skipping event-spine emission", { type: event.type });
    return event;
  }
  // Without Redis, Queue.add() never settles (ioredis keeps the command offline and retries),
  // which hung deal create/update until the browser retried and made a duplicate deal. Race it
  // against a timer like apps/api's enqueueDexterEventJob; the event is still in skout_events.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const added = q.add("process-event", { event }, { jobId: event.id }).then(
    () => "added" as const,
    (err: unknown) => {
      log.warn("dexter event enqueue failed", {
        type: event.type,
        err: err instanceof Error ? err.message : String(err),
      });
      return "failed" as const;
    }
  );
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ENQUEUE_TIMEOUT_MS);
  });
  const outcome = await Promise.race([added, timedOut]);
  if (timer) clearTimeout(timer);
  if (outcome === "timeout") {
    log.warn("dexter event enqueue timed out — Redis unreachable or slow; event kept in the log only", {
      type: event.type,
      timeoutMs: ENQUEUE_TIMEOUT_MS,
    });
  }
  return event;
}
