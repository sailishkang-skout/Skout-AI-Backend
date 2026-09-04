import { Queue } from "bullmq";
import { createEvent, type CreateEventInput, type SkoutEvent } from "@skout/shared";
import { serviceLog } from "../lib/obs.js";
import type { Env } from "../config/env.js";
import { redisBullMqConnection } from "../lib/redis.js";

const log = serviceLog("skout-event");

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
  config: Env,
  input: CreateEventInput<T>
): Promise<SkoutEvent<T>> {
  const event = createEvent(input);
  const q = getQueue(config);
  if (!q) {
    log.warn("REDIS_URL unset — skipping event-spine emission", { type: event.type });
    return event;
  }
  await q.add("process-event", { event }, { jobId: event.id }).catch((err: unknown) => {
    log.warn("dexter event enqueue failed", {
      type: event.type,
      err: err instanceof Error ? err.message : String(err),
    });
  });
  return event;
}
