/**
 * COPS-01 — audit event builder for Bible Appendix D requirements.
 *
 * Validates every high-impact change before it is written: actor, impersonation context, tenant,
 * entity and action, before/after where relevant, reason for manual overrides, request/correlation
 * id and source channel. Persisting the result is done by the caller; this module decides what a
 * valid audit record is.
 */

export const COPS_SOURCE_CHANNELS = ["web", "api", "webhook", "worker", "import", "system"] as const;
export type CopsSourceChannel = (typeof COPS_SOURCE_CHANNELS)[number];

export interface CopsAuditInput {
  tenantId: string;
  actor: { type: "user" | "system" | "ai" | "integration"; id: string | null };
  /** Set when a support user acts as the customer. Null otherwise. */
  impersonatorId?: string | null;
  entityType: string;
  entityId: string;
  action: string;
  before?: unknown;
  after?: unknown;
  /** Required when `override` is true. */
  reason?: string | null;
  override?: boolean;
  correlationId: string;
  sourceChannel: CopsSourceChannel;
  occurredAt?: Date;
}

export interface CopsAuditRecord extends CopsAuditInput {
  occurredAt: Date;
}

export class CopsAuditValidationError extends Error {
  constructor(public readonly field: string, message: string) {
    super(message);
    this.name = "CopsAuditValidationError";
  }
}

/** Throws CopsAuditValidationError on the first missing or inconsistent field. */
export function buildCopsAuditRecord(input: CopsAuditInput, now: Date = new Date()): CopsAuditRecord {
  if (!input.tenantId) throw new CopsAuditValidationError("tenantId", "tenantId is required");
  if (!input.entityType) throw new CopsAuditValidationError("entityType", "entityType is required");
  if (!input.entityId) throw new CopsAuditValidationError("entityId", "entityId is required");
  if (!input.action) throw new CopsAuditValidationError("action", "action is required");
  if (input.actor.type === "user" && !input.actor.id) {
    throw new CopsAuditValidationError("actor.id", "A user audit event requires an actor id");
  }
  if (!input.correlationId) throw new CopsAuditValidationError("correlationId", "correlationId is required");
  if (!COPS_SOURCE_CHANNELS.includes(input.sourceChannel)) {
    throw new CopsAuditValidationError("sourceChannel", "sourceChannel is not a known channel");
  }
  if (input.override && !input.reason?.trim()) {
    throw new CopsAuditValidationError("reason", "A manual override cannot be saved without a reason");
  }
  return { ...input, occurredAt: input.occurredAt ?? now };
}
