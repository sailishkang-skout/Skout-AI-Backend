import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

/**
 * §7.3 SP-11 — durable log of every SkoutEvent emitted via emitSkoutEvent(). Before this, the
 * event spine was fire-and-forget (BullMQ enqueue + outbound webhook only, see
 * skout-event.service.ts) — real for consumers watching in real time, but nothing a support
 * engineer could query after the fact, and no UI could ever show a tenant's event history.
 *
 * Written best-effort, non-blocking, alongside the existing BullMQ enqueue and webhook dispatch
 * (same emitSkoutEvent call site) — a logging failure must never fail the action that triggered
 * the event.
 *
 * `id` reuses the event's own id (already a fresh UUID from createEvent()) rather than
 * generating a second one, so a support engineer can correlate this row with the same id seen
 * in webhook payloads/BullMQ job data.
 */
export const skoutEvents = pgTable(
  "skout_events",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    /** The primary business entity this event describes — usually a uuid from another table,
     * but not a Postgres FK: the event spine spans many different entity tables (plans,
     * sequences, signals, deals, ...) and falls back to workspaceId for workspace-scoped events
     * with no tighter aggregate (see SkoutEvent's own doc comment in event-envelope.ts). */
    aggregateId: text("aggregate_id").notNull(),
    /** Threads causally related events — the same value across every event in one Dexter run,
     * so a support engineer can trace a single run end to end (vision §11.3). */
    correlationId: text("correlation_id").notNull(),
    data: jsonb("data").notNull().default({}),
    /** When the event actually happened (SkoutEvent.occurredAt), not when this row was written. */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("skout_events_workspace_occurred_idx").on(table.workspaceId, table.occurredAt),
    index("skout_events_workspace_type_idx").on(table.workspaceId, table.type),
    index("skout_events_correlation_idx").on(table.correlationId),
  ]
);
