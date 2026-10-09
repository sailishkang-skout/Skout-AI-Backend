/**
 * COPS-01 — outbox writer and relay retry policy (ADR 0017).
 *
 * `appendCopsEvent` must be called with the same transaction handle as the state change it
 * describes, so the event row commits or rolls back together with the change.
 */
import { schema } from "@skout/db";
import { parseCopsEvent, type CopsEnvelope } from "./copos-events.js";

const { copsOutbox } = schema;

/** Relay gives up after this many failed publish attempts and dead-letters the row. */
export const COPS_OUTBOX_MAX_ATTEMPTS = 8;

const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 15 * 60 * 1_000;

/** Exponential backoff: 1s, 2s, 4s ... capped at 15 minutes. `attempts` counts failures so far. */
export function copsOutboxBackoffMs(attempts: number): number {
  const exp = Math.max(0, attempts - 1);
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** exp);
}

/** Minimal shape of a Drizzle transaction handle that `appendCopsEvent` needs. */
export interface CopsOutboxTx {
  insert: (table: typeof copsOutbox) => {
    values: (row: typeof copsOutbox.$inferInsert) => Promise<unknown>;
  };
}

/**
 * Validate the envelope against the Phase 1 registry, then insert it into `cops_outbox` inside
 * the caller's transaction. Invalid envelopes throw before any write happens.
 */
export async function appendCopsEvent(tx: CopsOutboxTx, input: unknown): Promise<CopsEnvelope> {
  const envelope = parseCopsEvent(input);
  await tx.insert(copsOutbox).values({
    id: envelope.event_id,
    tenantId: envelope.tenant_id,
    eventType: envelope.event_type,
    aggregateType: envelope.aggregate_type,
    aggregateId: envelope.aggregate_id,
    envelope: envelope as unknown as Record<string, unknown>,
  });
  return envelope;
}
