import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import {
  appendCopsEvent,
  applyCopsTransition,
  COPS_INITIAL_STATES,
  createCopsEvent,
  type CopsDimension,
} from "@skout/shared";
import { writeCopsAudit } from "./cops-platform.service.js";

const { copsLifecycleStates } = schema;

export interface LifecycleTransitionInput {
  workspaceId: string;
  dimension: CopsDimension;
  entityId: string;
  to: string;
  actorId: string;
  source: string;
  reason: string;
  requestId: string;
  occurredAt: Date;
}

/**
 * One lifecycle transition, run inside the caller's transaction: initialise the state row, lock
 * it, apply the allowed-transition table (throws CopsIllegalTransitionError -> 409), update the
 * state, write the audit row, and append LifecycleTransitioned to the outbox. Shared by the
 * lifecycle route and the opportunity stage change so the rules live in one place.
 */
export async function runLifecycleTransition(tx: Db, input: LifecycleTransitionInput) {
  const { workspaceId, dimension, entityId, to, actorId, source, reason, requestId, occurredAt } = input;
      await tx
        .insert(copsLifecycleStates)
        .values({ workspaceId, dimension, entityId, state: COPS_INITIAL_STATES[dimension] })
        .onConflictDoNothing();

      const [current] = await tx
        .select()
        .from(copsLifecycleStates)
        .where(
          and(
            eq(copsLifecycleStates.workspaceId, workspaceId),
            eq(copsLifecycleStates.dimension, dimension),
            eq(copsLifecycleStates.entityId, entityId)
          )
        )
        .for("update")
        .limit(1);
      if (!current) throw new Error("Lifecycle state row missing after initialization");

      const transition = applyCopsTransition({
        dimension,
        from: current.state,
        to: to,
        actor: { type: "user", id: actorId },
        source: source,
        reason: reason,
        at: occurredAt,
      });
      await tx
        .update(copsLifecycleStates)
        .set({ state: transition.to, updatedAt: transition.at })
        .where(
          and(
            eq(copsLifecycleStates.workspaceId, workspaceId),
            eq(copsLifecycleStates.dimension, dimension),
            eq(copsLifecycleStates.entityId, entityId)
          )
        );

      await writeCopsAudit(tx, {
        tenantId: workspaceId,
        actor: transition.actor,
        entityType: `cops_${dimension}`,
        entityId,
        action: "lifecycle.transitioned",
        before: { state: transition.from },
        after: { state: transition.to },
        reason: transition.reason,
        correlationId: requestId,
        sourceChannel: source === "web" ? "web" : "api",
        occurredAt: transition.at,
      });

      const event = createCopsEvent({
        eventType: "LifecycleTransitioned",
        tenantId: workspaceId,
        aggregateType: dimension,
        aggregateId: entityId,
        actor: transition.actor,
        correlationId: requestId,
        payload: {
          dimension,
          entity_id: entityId,
          from: transition.from,
          to: transition.to,
          source: transition.source,
          reason: transition.reason,
        },
        occurredAt: transition.at,
      });
      await appendCopsEvent(tx as never, event);
      return transition;
  return transition;
}
