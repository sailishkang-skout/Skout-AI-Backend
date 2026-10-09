import { and, eq } from "drizzle-orm";
import { schema } from "@skout/db";
import { createCopsEvent } from "./copos-events.js";
import { appendCopsEvent } from "./cops-outbox.js";

/**
 * COPS-02: one helper every activity-writing path calls inside its own transaction, so each
 * activity reaches the account timeline through an ActivityRecorded event (outbox + projector).
 * Used by the CRM ActivitiesService, the LinkedIn voice handoff, and the automation CRM writeback.
 */

// Structural type: any Drizzle transaction (or db) with select and insert.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

export interface ActivityRecordedInput {
  workspaceId: string;
  activityId: string;
  activityType: string;
  entityType: string;
  entityId: string;
  subject?: string | null;
  visibility?: "public" | "internal";
  actorUserId?: string | null;
  correlationId?: string;
}

/** The account (company) an activity belongs to, for the account timeline. Null when there is none. */
export async function accountIdForActivity(tx: Tx, workspaceId: string, entityType: string, entityId: string): Promise<string | null> {
  const { contacts, deals } = schema;
  if (entityType === "company") return entityId;
  if (entityType === "contact") {
    const [c] = await tx
      .select({ companyId: contacts.companyId })
      .from(contacts)
      .where(and(eq(contacts.id, entityId), eq(contacts.workspaceId, workspaceId)))
      .limit(1);
    return c?.companyId ?? null;
  }
  if (entityType === "deal") {
    const [d] = await tx
      .select({ companyId: deals.companyId })
      .from(deals)
      .where(and(eq(deals.id, entityId), eq(deals.workspaceId, workspaceId)))
      .limit(1);
    return d?.companyId ?? null;
  }
  return null;
}

export async function appendActivityRecorded(tx: Tx, input: ActivityRecordedInput): Promise<void> {
  const accountId = await accountIdForActivity(tx, input.workspaceId, input.entityType, input.entityId);
  await appendCopsEvent(
    tx,
    createCopsEvent({
      eventType: "ActivityRecorded",
      tenantId: input.workspaceId,
      aggregateType: input.entityType,
      aggregateId: input.entityId,
      actor: input.actorUserId ? { type: "user", id: input.actorUserId } : { type: "system", id: null },
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      payload: {
        activity_id: input.activityId,
        activity_type: input.activityType,
        entity_type: input.entityType,
        entity_id: input.entityId,
        account_id: accountId,
        subject: input.subject ?? null,
        visibility: input.visibility ?? "public",
      },
    })
  );
}
