import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo } from "@skout/db";
import { createLogger } from "@skout/observability";

const { crmSyncHistory, crmOutboundWrites, crmConflicts } = schema;
const log = createLogger("crm-sync-history");

/** What one pulled provider record did to Skout. */
export type CrmInboundOutcome =
  | "created"
  | "updated"
  | "unchanged"
  | "held_by_conflict"
  | "skipped_out_of_scope"
  | "skipped_invalid";

export interface RecordInboundInput {
  workspaceId: string;
  connectionId: string;
  entityType: "contact" | "deal";
  entityId?: string | null;
  externalId: string;
  outcome: CrmInboundOutcome;
  fields?: string[];
  heldFields?: string[];
  detail?: string | null;
  externalModifiedAt?: Date | null;
}

/**
 * COPS-09 per-record history, inbound side. Best effort: a history write that fails is logged and
 * never fails the sync (the record itself was already applied or skipped).
 */
export async function recordInboundSync(db: Db, input: RecordInboundInput): Promise<void> {
  try {
    await db.insert(crmSyncHistory).values({
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      externalId: input.externalId,
      outcome: input.outcome,
      fields: input.fields ?? [],
      heldFields: input.heldFields ?? [],
      detail: input.detail ?? null,
      externalModifiedAt: input.externalModifiedAt && !Number.isNaN(input.externalModifiedAt.getTime()) ? input.externalModifiedAt : null,
    });
  } catch (err) {
    log.warn("could not record inbound CRM sync history", { err, entityType: input.entityType, externalId: input.externalId });
  }
}

export async function listInboundSyncHistory(
  db: Db,
  workspaceId: string,
  opts: { entityType?: string; outcome?: string; limit?: number; offset?: number } = {}
) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const conditions = [eq(crmSyncHistory.workspaceId, workspaceId)];
  if (opts.entityType) conditions.push(eq(crmSyncHistory.entityType, opts.entityType));
  if (opts.outcome) conditions.push(eq(crmSyncHistory.outcome, opts.outcome));
  return db
    .select()
    .from(crmSyncHistory)
    .where(and(...conditions))
    .orderBy(desc(crmSyncHistory.createdAt))
    .limit(limit)
    .offset(offset);
}

export interface RecordHistoryItem {
  at: string;
  direction: "inbound" | "outbound" | "conflict";
  status: string;
  fields: string[];
  detail: string | null;
  id: string;
}

/**
 * One Skout record's sync history, newest first: what each pull did (inbound), each push and its
 * result (outbound, the DLQ rows included), and each conflict with its resolution.
 */
export async function getRecordSyncHistory(
  db: Db,
  workspaceId: string,
  entityType: "contact" | "deal",
  entityId: string,
  limit = 100
): Promise<RecordHistoryItem[]> {
  const [inbound, outbound, conflicts] = await Promise.all([
    db
      .select()
      .from(crmSyncHistory)
      .where(scopedTo(crmSyncHistory, workspaceId, eq(crmSyncHistory.entityType, entityType), eq(crmSyncHistory.entityId, entityId)))
      .orderBy(desc(crmSyncHistory.createdAt))
      .limit(limit),
    db
      .select()
      .from(crmOutboundWrites)
      .where(scopedTo(crmOutboundWrites, workspaceId, eq(crmOutboundWrites.entityType, entityType), eq(crmOutboundWrites.entityId, entityId)))
      .orderBy(desc(crmOutboundWrites.createdAt))
      .limit(limit),
    db
      .select()
      .from(crmConflicts)
      .where(scopedTo(crmConflicts, workspaceId, eq(crmConflicts.entityType, entityType), eq(crmConflicts.entityId, entityId)))
      .orderBy(desc(crmConflicts.createdAt))
      .limit(limit),
  ]);

  const items: RecordHistoryItem[] = [
    ...inbound.map((h) => ({
      at: h.createdAt.toISOString(),
      direction: "inbound" as const,
      status: h.outcome,
      fields: [...(h.fields ?? []), ...(h.heldFields ?? []).map((f) => `${f} (held)`)],
      detail: h.detail,
      id: h.id,
    })),
    ...outbound.map((w) => ({
      at: w.createdAt.toISOString(),
      direction: "outbound" as const,
      status: w.status,
      fields: Object.keys((w.patch ?? {}) as Record<string, unknown>),
      detail: w.lastError,
      id: w.id,
    })),
    ...conflicts.map((c) => ({
      at: c.createdAt.toISOString(),
      direction: "conflict" as const,
      status: c.status,
      fields: [c.fieldName],
      detail: c.status === "pending" ? `Skout "${c.skoutValue ?? ""}" vs HubSpot "${c.externalValue ?? ""}"` : `resolved to "${c.resolvedValue ?? ""}"`,
      id: c.id,
    })),
  ];
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}
