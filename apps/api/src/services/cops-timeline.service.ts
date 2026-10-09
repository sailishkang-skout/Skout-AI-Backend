import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { projectCopsEventToTimeline } from "@skout/shared";

/**
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md (COPS-02 additions).
 *   - Tables touched directly: deals - read only (resolve the account of an opportunity event) (owned by apps/crm)
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: The timeline projector runs inside the BullMQ event consumer; resolving an opportunity to its
 *     account is one indexed read per event, and an HTTP round trip there would add latency and a
 *     failure mode to event consumption (same rationale as the sweep workers in ADR 0003).
 *   - Review date: revisit when apps/crm's internal API covers transactional writes
 */

const { companies, copsTimelineEvents, deals } = schema;
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
export async function accountIdForEvent(db: Db, event: TimelineSourceEvent): Promise<string | null> {
  const p = event.payload ?? {};
  if (typeof p.account_id === "string" && UUID.test(p.account_id)) return p.account_id;
  if (p.dimension === "account" && typeof p.entity_id === "string" && UUID.test(p.entity_id)) return p.entity_id;
  // Opportunity events: the entity is a deal; its timeline belongs to the deal's company, if it has one.
  // Commercial lifecycle rows are keyed by the opportunity too (COPS-03), and commercial events
  // (ProposalSent, ContractSigned, PaymentSucceeded, ...) carry opportunity_id.
  const opportunityId =
    (p.dimension === "opportunity" || p.dimension === "commercial") && typeof p.entity_id === "string"
      ? p.entity_id
      : typeof p.opportunity_id === "string"
        ? p.opportunity_id
        : null;
  if (opportunityId && UUID.test(opportunityId)) {
    const [deal] = await db
      .select({ companyId: deals.companyId })
      .from(deals)
      .where(and(eq(deals.id, opportunityId), eq(deals.workspaceId, event.tenant_id)))
      .limit(1);
    return deal?.companyId ?? null;
  }
  return null;
}

/**
 * Idempotent projector. Writes at most one timeline row per (workspace, event, account) because
 * the table has a unique constraint; a redelivered event is a no-op. Returns whether a row was
 * written.
 */
export async function projectCopsEventToTimelineRow(db: Db, event: TimelineSourceEvent): Promise<boolean> {
  const projection = projectCopsEventToTimeline(event);
  if (!projection) return false;
  const accountId = (await accountIdForEvent(db, event)) ?? null;
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
