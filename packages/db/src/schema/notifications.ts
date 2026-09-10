import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

/**
 * R17.1 — Notification center. Extensible `type` (free-text, not a DB enum) so new alert
 * types — R17.3 signal alerts, R17.2 task/sequence reminders, R13.4 rule firings, etc. — plug
 * in without a schema change, per the R17.1 acceptance criteria.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Null = workspace-wide broadcast (e.g. an unassigned task's reminder). */
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    /** Optional deep link target, e.g. entityType="prospect", entityId=<prospectId>. Also
     * powers R17.2's auto-resolve — resolveNotificationsForEntity marks unread notifications
     * for an (entityType, entityId) pair as read once the underlying thing no longer needs it. */
    entityType: text("entity_type"),
    /** Text, not uuid — some entities (signals, corpus prospects) are identified by hash strings. */
    entityId: text("entity_id"),
    /** Which channels this notification was actually delivered through — for debugging/audit, not preference. */
    deliveredChannels: jsonb("delivered_channels").notNull().default([]),
    readAt: timestamp("read_at", { withTimezone: true }),
    /** R17.3 digest delivery — set once this row has been folded into a daily digest email, so the sweep doesn't re-send it. Null for real-time-delivered or not-yet-digested rows. */
    digestedAt: timestamp("digested_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("notifications_workspace_user_idx").on(table.workspaceId, table.userId),
    index("notifications_workspace_user_unread_idx").on(table.workspaceId, table.userId, table.readAt),
    index("notifications_workspace_type_idx").on(table.workspaceId, table.type),
    index("notifications_entity_idx").on(table.entityType, table.entityId),
  ]
);

/**
 * R17.4 — per-notification-type channel preference. A row with type="*" is a user's default
 * for any type without its own row. Missing rows fall back to in_app-only (safe default: never
 * silently start emailing someone who hasn't opted in).
 */
export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    /** "in_app" | "email" | "both" */
    channel: text("channel").notNull().default("in_app"),
    /** R17.3 — when true and channel includes email, email delivery is batched into the daily digest sweep instead of sent real-time. */
    digest: boolean("digest").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("notification_preferences_workspace_user_type_idx").on(table.workspaceId, table.userId, table.type)]
);
