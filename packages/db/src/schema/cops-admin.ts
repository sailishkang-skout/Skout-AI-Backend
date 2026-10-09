import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

/**
 * COPS-07 versioned admin configuration (credit packages, trial templates, email templates,
 * retention policy, feature flags). An edit inserts the next version; rows are
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

/**
 * COPS-07 retention runs. A dry run records what would be removed; an apply run records what was,
 * and always points at the dry run it followed (CHECK in migration 0116).
 */
export const copsRetentionRuns = pgTable(
  "cops_retention_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** dry_run | apply */
    mode: text("mode").notNull(),
    status: text("status").notNull().default("completed"),
    policyVersion: integer("policy_version").notNull(),
    counts: jsonb("counts").$type<Record<string, unknown>>().notNull().default({}),
    dryRunId: uuid("dry_run_id").references((): AnyPgColumn => copsRetentionRuns.id, { onDelete: "set null" }),
    reason: text("reason"),
    requestedBy: uuid("requested_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("cops_retention_runs_workspace_idx").on(table.workspaceId, table.createdAt)]
);
