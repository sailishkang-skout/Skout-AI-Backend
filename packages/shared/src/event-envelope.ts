/**
 * §12 — Versioned Event Envelope
 *
 * The canonical event wrapper for every domain event emitted by Skout — whether
 * delivered via BullMQ, outbound webhook, or the future Dexter event spine.
 *
 * Design rules (from the Enterprise Completion Plan §12):
 *  - Every event carries a stable `type` string in `<domain>.<action>` form.
 *  - `version` follows SemVer-major only ("1", "2"). Consumers must reject
 *    versions they don't understand rather than silently ignore new fields.
 *  - `correlationId` threads a chain of causally related events (e.g. the
 *    original icp.approved that triggered a tam.approved that triggered a
 *    regional_brief.approved). Set it to the triggering event's `id` when
 *    emitting a downstream event, or to `id` itself when starting a new chain.
 *  - `aggregateId` is the primary business entity this event describes
 *    (workspaceId, prospectId, sequenceId, etc.).
 *  - The envelope is intentionally transport-agnostic: the same type is used in
 *    BullMQ job payloads, outbound webhook bodies, and SSE streams.
 */
export interface SkoutEvent<T extends Record<string, unknown> = Record<string, unknown>> {
  /** Unique, stable event identity (UUID v4). Used for idempotency and dedup. */
  id: string;
  /** Dot-separated event type: `<domain>.<action>`, e.g. `icp.approved`. */
  type: SkoutEventType;
  /** Envelope schema version (SemVer-major string). Currently "1". */
  version: "1";
  /** Tenant owning this event. Never crosses tenant boundaries. */
  tenantId: string;
  /**
   * Primary business aggregate this event describes.
   * Convention: use the most-specific stable identifier available
   * (sequenceId, prospectId, briefId, …). Falls back to tenantId for
   * workspace-scoped events with no tighter aggregate.
   */
  aggregateId: string;
  /**
   * Threads causally related events.
   * Set to the triggering event's `id`; set to own `id` when starting a chain.
   */
  correlationId: string;
  /** ISO-8601 UTC timestamp of when the event was created. */
  occurredAt: string;
  /** Domain-specific payload. Callers narrow the generic param T. */
  data: T;
}

// ---------------------------------------------------------------------------
// Canonical event type registry (§12 + §7.3 Dexter event spine)
// Keep in sync with WEBHOOK_EVENT_TYPES in webhook.service.ts
// ---------------------------------------------------------------------------

/** Dexter platform lifecycle events (§7.3 event spine). */
export const DEXTER_EVENT_TYPES = [
  "icp.approved",
  "icp.rejected",
  "tam.approved",
  "tam.rejected",
  "regional_brief.approved",
  "regional_brief.rejected",
  "dexter.plan.proposed",
  "dexter.plan.approved",
  "dexter.plan.rejected",
  "dexter.plan.blocked",
  "dexter.action.executed",
  "dexter.outcome.captured",
  "dexter.learning.recommended",
  "dexter.learning.approved",
] as const;

/** Outreach & sequence events (§8.6). */
export const SEQUENCE_EVENT_TYPES = [
  "prospect.enrolled",
  "sequence.step.completed",
  "reply.received",
] as const;

/**
 * §7.3 — the remaining 7 of the 10 minimum Dexter event-spine types. Distinct from
 * SEQUENCE_EVENT_TYPES above: those are pre-existing ad-hoc webhook-only events dispatched
 * directly via dispatchWebhookEvent; these are first-class spine events carrying the full
 * versioned envelope (BullMQ + webhook fan-out via emitSkoutEvent).
 */
export const GTM_OUTCOME_EVENT_TYPES = [
  "signal.detected",
  "enrichment.completed",
  "sequence.approved",
  "touchpoint.completed",
  "reply.classified",
  "meeting.completed",
  "opportunity.updated",
] as const;

/** All first-class Skout event types. Single source of truth. */
export const SKOUT_EVENT_TYPES = [
  ...DEXTER_EVENT_TYPES,
  ...SEQUENCE_EVENT_TYPES,
  ...GTM_OUTCOME_EVENT_TYPES,
] as const;

export type SkoutEventType = (typeof SKOUT_EVENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";

export interface CreateEventInput<T extends Record<string, unknown>> {
  type: SkoutEventType;
  tenantId: string;
  aggregateId: string;
  /** Omit to start a new correlation chain (correlationId = event.id). */
  correlationId?: string;
  data: T;
}

/**
 * Build a fully-formed `SkoutEvent<T>` with a fresh UUID and current timestamp.
 *
 * ```ts
 * const event = createEvent({
 *   type: "icp.approved",
 *   tenantId: workspace.id,
 *   aggregateId: icp.id,
 *   data: { icpId: icp.id, approvedBy: userId },
 * });
 * ```
 */
export function createEvent<T extends Record<string, unknown>>(
  input: CreateEventInput<T>
): SkoutEvent<T> {
  const id = randomUUID();
  return {
    id,
    type: input.type,
    version: "1",
    tenantId: input.tenantId,
    aggregateId: input.aggregateId,
    correlationId: input.correlationId ?? id,
    occurredAt: new Date().toISOString(),
    data: input.data,
  };
}

/**
 * Type-safe guard: narrow an `unknown` value to `SkoutEvent`.
 * Rejects envelope version mismatches so consumers fail fast on upgrades.
 */
export function isSkoutEvent(value: unknown): value is SkoutEvent {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    typeof v["type"] === "string" &&
    v["version"] === "1" &&
    typeof v["tenantId"] === "string" &&
    typeof v["aggregateId"] === "string" &&
    typeof v["correlationId"] === "string" &&
    typeof v["occurredAt"] === "string" &&
    typeof v["data"] === "object" &&
    v["data"] !== null
  );
}
