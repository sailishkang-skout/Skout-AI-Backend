import { integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

/**
 * COPS-07 versioned admin configuration (credit packages, trial templates, email templates,
 * notification routing, retention policy, feature flags). An edit inserts the next version; rows are
 * immutable (trigger in migration 0115), so anything that pinned a version keeps reading it.
 */
export const copsConfigVersions = pgTable(
  "cops_config_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    key: text("key").notNull(),
    version: integer("version").notNull(),
    value: jsonb("value").$type<Record<string, unknown>>().notNull(),
    reason: text("reason").notNull(),
    /** Set when this version was created by a rollback. */
    restoredFromVersion: integer("restored_from_version"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("cops_config_versions_uq").on(table.workspaceId, table.kind, table.key, table.version)]
);
