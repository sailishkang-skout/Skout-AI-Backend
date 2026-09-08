import {
  createEvent,
  GTM_OUTCOME_EVENT_TYPES,
  type CreateEventInput,
  type SkoutEvent,
  type SkoutEventType,
} from "@skout/shared";
import { createLogger } from "@skout/observability";
import { and, desc, eq, lt } from "drizzle-orm";
import { schema } from "@skout/db";
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

  // §7.3 SP-11 — durable log so the event spine can be queried after the fact (support tracing,
  // the Dexter command center's event timeline), not just watched live via BullMQ/webhooks.
  // Best-effort: a logging failure must never fail the action that triggered the event.
  if (db) {
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
  }

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

export interface ListSkoutEventsOptions {
  type?: string;
  /** Keyset pagination — pass the last-seen row's occurredAt to fetch the next older page. */
  before?: string | Date;
  limit?: number;
}

/**
 * §7.3 SP-11 — reverse-chronological event feed for the Dexter command center's event timeline.
 * Tenant-scoped, filterable by exact event type, keyset-paginated on occurredAt (not
 * offset-based — an event feed is append-heavy and offset pagination drifts under concurrent
 * writes).
 */
export async function listSkoutEvents(db: Db, workspaceId: string, options: ListSkoutEventsOptions = {}) {
  const { skoutEvents } = schema;
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);

  const conditions = [eq(skoutEvents.workspaceId, workspaceId)];
  if (options.type) conditions.push(eq(skoutEvents.type, options.type));
  if (options.before) conditions.push(lt(skoutEvents.occurredAt, new Date(options.before)));

  return db
    .select()
    .from(skoutEvents)
    .where(and(...conditions))
    .orderBy(desc(skoutEvents.occurredAt))
    .limit(limit);
}

export function isDexterSpineEvent(type: string): type is SkoutEventType {
  return (
    type.startsWith("icp.") ||
    type.startsWith("tam.") ||
    type.startsWith("regional_brief.") ||
    type.startsWith("dexter.") ||
    (GTM_OUTCOME_EVENT_TYPES as readonly string[]).includes(type)
  );
}
