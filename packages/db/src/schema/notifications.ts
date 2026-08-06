import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

/**
 * In-app notification center (R17.1) — the foundation every alert type (list refresh, signal
 * alert, task/sequence reminder, ...) plugs into. `type` is free-form text, not a Postgres enum,
 * so new alert kinds can be added without a schema change (matches this codebase's existing
 * convention for extensible classification columns — smart_lists.refresh_cadence, signals.signal_type).
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Null = workspace-wide broadcast (e.g. unassigned task). */
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    entityType: text("entity_type").notNull(),
    /** Text, not uuid — some entities (signals, corpus prospects) are identified by hash strings. */
    entityId: text("entity_id").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("notifications_workspace_user_read_idx").on(table.workspaceId, table.userId, table.readAt),
    index("notifications_workspace_type_idx").on(table.workspaceId, table.type),
    index("notifications_entity_idx").on(table.entityType, table.entityId),
  ]
);
