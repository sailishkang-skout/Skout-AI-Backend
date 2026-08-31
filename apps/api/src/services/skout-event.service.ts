import { createEvent, type CreateEventInput, type SkoutEvent, type SkoutEventType } from "@skout/shared";
import { createLogger } from "@skout/observability";
import type { Db } from "@skout/db";
import type { Env } from "../config/env.js";
import { dispatchWebhookEvent, type WebhookEventType } from "./webhook.service.js";
import { enqueueDexterEventJob } from "../workers/dexter-event.queue.js";

const log = createLogger("skout-event");

/**
 * §7.3 — Transport decision: BullMQ (`skout-dexter-event` queue) is the internal event bus;
 * outbound webhooks fan out the same `SkoutEvent` envelope to customer endpoints.
 */
export async function emitSkoutEvent<T extends Record<string, unknown>>(
  db: Db | null,
  config: Env,
  input: CreateEventInput<T>
): Promise<SkoutEvent<T>> {
  const event = createEvent(input);

  await enqueueDexterEventJob(config, { event }).catch((err: unknown) => {
    log.warn("dexter event enqueue failed — continuing with webhook dispatch", {
      type: event.type,
      err: err instanceof Error ? err.message : String(err),
    });
  });

  if (db) {
    await dispatchWebhookEvent(
      db,
      config,
      event.type as WebhookEventType,
      event.tenantId,
      event as unknown as Record<string, unknown>
    ).catch((err: unknown) => {
      log.warn("webhook dispatch failed for skout event", {
        type: event.type,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }

  log.debug("emitted skout event", { type: event.type, id: event.id, correlationId: event.correlationId });
  return event;
}

export function isDexterSpineEvent(type: string): type is SkoutEventType {
  return (
    type.startsWith("icp.") ||
    type.startsWith("tam.") ||
    type.startsWith("regional_brief.") ||
    type.startsWith("dexter.")
  );
}
