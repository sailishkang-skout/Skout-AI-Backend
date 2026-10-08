import { index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { companies } from "./crm.js";

/**
 * COPS-02 normalised timeline. Rows are projected from COPS domain events by an idempotent
 * projector: (workspace_id, source_event_id, account_id) is unique, so a redelivered event
 * writes nothing new. Internal rows (visibility = 'internal') are gated at read time.
 */
export const copsTimelineEvents = pgTable(
  "cops_timeline_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    visibility: text("visibility").notNull().default("public"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    sourceEventId: uuid("source_event_id").notNull(),
    eventType: text("event_type").notNull(),
    summary: text("summary").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueProjection: unique("cops_timeline_events_source_unique").on(
      table.workspaceId,
      table.sourceEventId,
      table.accountId
    ),
    accountIdx: index("cops_timeline_events_account_idx").on(table.workspaceId, table.accountId, table.occurredAt),
  })
);
