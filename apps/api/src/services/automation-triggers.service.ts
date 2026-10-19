import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { COPS_PHASE1_EVENTS } from "@skout/shared";
import { createLogger } from "@skout/observability";
import type { AutomationGraph } from "./automation-graph.js";
import { findStartNodes } from "./automation-graph.js";
import { cancelRun, createAutomationRunOnce } from "./automation-run.service.js";

const { automations, automationVersions, automationRuns, copsOutbox, copsProcessedEvents } = schema;
const log = createLogger("automation-triggers");

/**
 * COPS-10 triggers (Bible p.68: event, schedule, field/state change). The trigger node's config
 * says how a workflow starts, and which events stop its open runs (p.74: reply, activation,
 * opt-out). No `kind` means manual or webhook only, as before.
 */
export const TRIGGER_KINDS = ["manual", "event", "state_change", "schedule"] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];
export const STATE_CHANGE_EVENTS = ["LifecycleTransitioned", "SubscriptionStatusChanged"] as const;
export const WORKFLOW_EVENT_TYPES = Object.keys(COPS_PHASE1_EVENTS);
export const MIN_SCHEDULE_MINUTES = 5;

export interface TriggerConfig {
  kind?: TriggerKind;
  /** event / state_change: the COPS event type. */
  eventType?: string;
  /** state_change: only this dimension (LifecycleTransitioned) and only into this state. */
  dimension?: string;
  toState?: string;
  /** schedule: one run per this many minutes. */
  everyMinutes?: number;
  /** Events that cancel this workflow's open runs for the same account. */
  stopOn?: string[];
}

/** The workflow's trigger config: the config of its trigger start node, if it has one. */
export function triggerConfigOf(graph: AutomationGraph): TriggerConfig {
  const trigger = findStartNodes(graph).find((n) => n.type === "trigger");
  return (trigger?.config ?? {}) as TriggerConfig;
}

const CONSUMER = "workflow-triggers";
/** Events older than this are never picked up (a new consumer does not replay history). */
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Envelope {
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
}

/** The account an event is about: payload.account_id, or the aggregate when it is an account. */
export function accountOfEvent(e: Envelope): string | null {
  const fromPayload = e.payload?.account_id;
  if (typeof fromPayload === "string" && UUID.test(fromPayload)) return fromPayload;
  if (e.aggregate_type === "account" && UUID.test(e.aggregate_id)) return e.aggregate_id;
  return null;
}

/** Whether a trigger config starts a run for this event. */
export function triggerMatches(t: TriggerConfig, e: Envelope): boolean {
  if (t.kind === "event") return t.eventType === e.event_type;
  if (t.kind === "state_change") {
    if (t.eventType !== e.event_type) return false;
    if (t.dimension && e.payload?.dimension !== t.dimension) return false;
    return !t.toState || e.payload?.to === t.toState;
  }
  return false;
}

interface LiveWorkflow {
  automationId: string;
  workspaceId: string;
  versionId: string;
  publishedAt: Date | null;
  graph: AutomationGraph;
  trigger: TriggerConfig;
}

/** Active workflows with their live (current) published version. */
async function liveWorkflows(db: Db, workspaceIds?: string[]): Promise<LiveWorkflow[]> {
  const rows = await db
    .select({
      automationId: automations.id,
      workspaceId: automations.workspaceId,
      versionId: automationVersions.id,
      publishedAt: automationVersions.publishedAt,
      graph: automationVersions.graph,
    })
    .from(automations)
    .innerJoin(
      automationVersions,
      and(eq(automationVersions.automationId, automations.id), eq(automationVersions.version, automations.currentVersion), eq(automationVersions.status, "published"))
    )
    .where(and(eq(automations.status, "active"), workspaceIds ? inArray(automations.workspaceId, workspaceIds) : undefined));
  return rows.map((r) => ({ ...r, graph: r.graph as AutomationGraph, trigger: triggerConfigOf(r.graph as AutomationGraph) }));
}

/**
 * Reads new outbox events once each (cops_processed_events, consumer "workflow-triggers") and,
 * per event, starts a run of every live workflow whose trigger matches (one run per event:
 * idempotency key event:<event_id>), then cancels open runs for the same account of every
 * workflow that stops on this event. A workflow only reacts to events after it was published.
 * Returns the runs to enqueue.
 */
export async function dispatchWorkflowEvents(db: Db, now = new Date(), options: { limit?: number; tenantIds?: string[] } = {}) {
  const limit = options.limit ?? 200;
  const events = await db
    .select({ id: copsOutbox.id, tenantId: copsOutbox.tenantId, createdAt: copsOutbox.createdAt, envelope: copsOutbox.envelope })
    .from(copsOutbox)
    .where(
      and(
        gt(copsOutbox.createdAt, new Date(now.getTime() - LOOKBACK_MS)),
        options.tenantIds ? inArray(copsOutbox.tenantId, options.tenantIds) : undefined,
        sql`not exists (select 1 from cops_processed_events p where p.consumer = ${CONSUMER} and p.event_id = ${copsOutbox.id})`
      )
    )
    .orderBy(asc(copsOutbox.createdAt))
    .limit(limit);
  if (!events.length) return { started: [] as { automationRunId: string; workspaceId: string }[], cancelled: 0 };

  const workflows = await liveWorkflows(db, [...new Set(events.map((e) => e.tenantId))]);
  const started: { automationRunId: string; workspaceId: string }[] = [];
  let cancelled = 0;
  for (const event of events) {
    const envelope = event.envelope as Envelope;
    const accountId = accountOfEvent(envelope);
    await db.transaction(async (tx) => {
      const [claimed] = await tx.insert(copsProcessedEvents).values({ consumer: CONSUMER, eventId: event.id }).onConflictDoNothing().returning();
      if (!claimed) return; // another sweep took this event
      const tenantFlows = workflows.filter((w) => w.workspaceId === event.tenantId);
      for (const w of tenantFlows) {
        if (!triggerMatches(w.trigger, envelope) || (w.publishedAt && event.createdAt < w.publishedAt)) continue;
        const { run, created } = await createAutomationRunOnce(tx as unknown as Db, {
          automationId: w.automationId,
          automationVersionId: w.versionId,
          workspaceId: w.workspaceId,
          triggerType: "event",
          triggerRef: `${envelope.event_type}:${event.id}`,
          graph: w.graph,
          idempotencyKey: `event:${event.id}`,
          triggerPayload: { event_type: envelope.event_type, event_id: event.id, aggregate_type: envelope.aggregate_type, aggregate_id: envelope.aggregate_id, ...envelope.payload },
          subject: accountId ? { type: "account", id: accountId } : undefined,
        });
        if (created) started.push({ automationRunId: run.id, workspaceId: w.workspaceId });
      }
      if (!accountId) return;
      const stopping = tenantFlows.filter((w) => w.trigger.stopOn?.includes(envelope.event_type)).map((w) => w.automationId);
      if (!stopping.length) return;
      const open = await tx
        .select({ id: automationRuns.id })
        .from(automationRuns)
        .where(
          and(
            eq(automationRuns.workspaceId, event.tenantId),
            inArray(automationRuns.automationId, stopping),
            eq(automationRuns.subjectType, "account"),
            eq(automationRuns.subjectId, accountId),
            inArray(automationRuns.status, ["pending", "running", "awaiting_approval"])
          )
        );
      for (const r of open) {
        await cancelRun(tx as unknown as Db, event.tenantId, r.id, undefined, `Stopped by ${envelope.event_type}`);
        cancelled++;
      }
    });
  }
  if (started.length || cancelled) log.info("workflow events dispatched", { events: events.length, started: started.length, cancelled });
  return { started, cancelled };
}

/**
 * Starts one run per schedule slot (floor(now / everyMinutes)) of every live scheduled workflow.
 * The idempotency key schedule:<slot> makes a second sweep in the same slot a no-op. Slots that
 * began before the version was published are skipped.
 */
export async function runScheduledWorkflows(db: Db, now = new Date(), options: { tenantIds?: string[] } = {}) {
  const started: { automationRunId: string; workspaceId: string }[] = [];
  for (const w of await liveWorkflows(db, options.tenantIds)) {
    if (w.trigger.kind !== "schedule") continue;
    const minutes = Math.max(MIN_SCHEDULE_MINUTES, Number(w.trigger.everyMinutes) || 0);
    const slotMs = minutes * 60_000;
    const slot = Math.floor(now.getTime() / slotMs);
    if (w.publishedAt && slot * slotMs < w.publishedAt.getTime()) continue;
    const { run, created } = await createAutomationRunOnce(db, {
      automationId: w.automationId,
      automationVersionId: w.versionId,
      workspaceId: w.workspaceId,
      triggerType: "schedule",
      triggerRef: `every ${minutes}m`,
      graph: w.graph,
      idempotencyKey: `schedule:${slot}`,
      triggerPayload: { scheduled_for: new Date(slot * slotMs).toISOString() },
    });
    if (created) started.push({ automationRunId: run.id, workspaceId: w.workspaceId });
  }
  return started;
}
