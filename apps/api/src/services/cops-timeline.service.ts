import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { projectCopsEventToTimeline } from "@skout/shared";

const { companies, copsTimelineEvents } = schema;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface TimelineSourceEvent {
  event_id: string;
  event_type: string;
  tenant_id: string;
  occurred_at?: string;
  actor?: { type: string; id: string | null };
  payload?: Record<string, unknown>;
}

/**
 * Which account a COPS event belongs to. Account-dimension lifecycle events carry the account id
 * as entity_id; other events may carry an explicit account_id. Anything else is not projected.
 */
export function accountIdForEvent(event: TimelineSourceEvent): string | null {
  const p = event.payload ?? {};
  const candidate =
    typeof p.account_id === "string" ? p.account_id : p.dimension === "account" && typeof p.entity_id === "string" ? p.entity_id : null;
  return candidate && UUID.test(candidate) ? candidate : null;
}

/**
 * Idempotent projector. Writes at most one timeline row per (workspace, event, account) because
 * the table has a unique constraint; a redelivered event is a no-op. Returns whether a row was
 * written.
 */
export async function projectCopsEventToTimelineRow(db: Db, event: TimelineSourceEvent): Promise<boolean> {
  const projection = projectCopsEventToTimeline(event);
  if (!projection) return false;
  const accountId = accountIdForEvent(event);
  if (!accountId) return false;

  const [account] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(and(eq(companies.id, accountId), eq(companies.workspaceId, event.tenant_id)))
    .limit(1);
  if (!account) return false;

  const inserted = await db
    .insert(copsTimelineEvents)
    .values({
      workspaceId: event.tenant_id,
      accountId,
      type: projection.type,
      visibility: projection.visibility,
      occurredAt: event.occurred_at ? new Date(event.occurred_at) : new Date(),
      actorType: event.actor?.type ?? "system",
      actorId: event.actor?.id ?? null,
      sourceEventId: event.event_id,
      eventType: event.event_type,
      summary: projection.summary,
      payload: event.payload ?? {},
    })
    .onConflictDoNothing()
    .returning({ id: copsTimelineEvents.id });
  return inserted.length === 1;
}
