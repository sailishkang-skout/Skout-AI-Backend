/**
 * COPS-01 — outbox relay step and idempotent consumer helper (ADR 0017).
 *
 * The relay is written as one pure step so the BullMQ worker can call it on a timer and tests can
 * drive it without Redis or Postgres. The worker owns the loop; this module owns the rules.
 */
import { COPS_OUTBOX_MAX_ATTEMPTS, copsOutboxBackoffMs } from "./cops-outbox.js";

export interface CopsOutboxRow {
  id: string;
  attempts: number;
  envelope: unknown;
}

/** Fields the worker writes back after a publish attempt. */
export type CopsOutboxUpdate =
  | { kind: "published"; publishedAt: Date }
  | { kind: "retry"; attempts: number; nextAttemptAt: Date; lastError: string }
  | { kind: "dead_letter"; attempts: number; deadLetteredAt: Date; lastError: string };

/**
 * Decide what to write after one publish attempt. `publish` resolves on success and throws on
 * failure. A failure below the attempt limit schedules a retry with backoff; at the limit the row
 * is dead-lettered for replay.
 */
export async function relayCopsOutboxRow(
  row: CopsOutboxRow,
  publish: (envelope: unknown) => Promise<void>,
  now: Date = new Date()
): Promise<CopsOutboxUpdate> {
  try {
    await publish(row.envelope);
    return { kind: "published", publishedAt: now };
  } catch (err) {
    const attempts = row.attempts + 1;
    const lastError = err instanceof Error ? err.message : String(err);
    if (attempts >= COPS_OUTBOX_MAX_ATTEMPTS) {
      return { kind: "dead_letter", attempts, deadLetteredAt: now, lastError };
    }
    return {
      kind: "retry",
      attempts,
      nextAttemptAt: new Date(now.getTime() + copsOutboxBackoffMs(attempts)),
      lastError,
    };
  }
}

/** Minimal store surface for the consumer helper. `insertIfAbsent` returns false on duplicate. */
export interface CopsProcessedStore {
  insertIfAbsent: (consumer: string, eventId: string) => Promise<boolean>;
}

/**
 * Run `handler` at most once per (consumer, event_id). The store claim happens first; if the
 * handler throws, the claim is released so a later delivery can retry. Use a transaction-bound store
 * in production so the claim and the side effect commit together.
 */
export async function processCopsEventOnce(
  store: CopsProcessedStore & { release?: (consumer: string, eventId: string) => Promise<void> },
  consumer: string,
  eventId: string,
  handler: () => Promise<void>
): Promise<"processed" | "duplicate"> {
  const claimed = await store.insertIfAbsent(consumer, eventId);
  if (!claimed) return "duplicate";
  try {
    await handler();
    return "processed";
  } catch (err) {
    await store.release?.(consumer, eventId);
    throw err;
  }
}

/** Envelope fields a consumer needs for logging and tracing. */
export interface CopsConsumedEvent {
  event_id: string;
  event_type: string;
  correlation_id: string;
  tenant_id: string;
}

/**
 * Consumer entry point: runs `handler` once per (consumer, event_id) and returns the correlation
 * fields so the caller can log and trace the same id that the originating request carried.
 */
export async function consumeCopsEvent(
  store: CopsProcessedStore & { release?: (consumer: string, eventId: string) => Promise<void> },
  consumer: string,
  event: CopsConsumedEvent,
  handler: (event: CopsConsumedEvent) => Promise<void>
): Promise<{ outcome: "processed" | "duplicate"; correlationId: string }> {
  const outcome = await processCopsEventOnce(store, consumer, event.event_id, () => handler(event));
  return { outcome, correlationId: event.correlation_id };
}
