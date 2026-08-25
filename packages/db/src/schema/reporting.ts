import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { users } from "./users.js";

/**
 * 8.15 — a saved subscription to the CRO rollup, delivered on a cadence with a
 * snapshot/version history (reportSnapshots below) instead of only a live query.
 */
export const reportSchedules = pgTable(
  "report_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** "daily" | "weekly" | "monthly" */
    cadence: text("cadence").notNull().default("weekly"),
    recipientEmails: text("recipient_emails").array().notNull().default([]),
    enabled: boolean("enabled").notNull().default(true),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
    nextSendAt: timestamp("next_send_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("report_schedules_workspace_idx").on(table.workspaceId)]
);

/**
 * One CroRollup captured at a point in time. `scheduleId` is null for an on-demand
 * snapshot (e.g. triggered from the board-pack export); `version` increases per
 * schedule so the delivery history is a real, orderable version history, not just a log.
 */
export const reportSnapshots = pgTable(
  "report_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scheduleId: uuid("schedule_id").references(() => reportSchedules.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
    rollup: jsonb("rollup").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("report_snapshots_schedule_idx").on(table.scheduleId, table.version),
    index("report_snapshots_workspace_idx").on(table.workspaceId, table.generatedAt),
  ]
);

/**
 * 8.15 forecasting split — model-generated (computed from the live rollup at save time),
 * manager-adjusted, and rep-committed numbers for one period, each with its own driver
 * explanation for the gap. Manager/rep figures are captured as explicit human input for
 * this pass — there's no per-deal "committed" flag yet to auto-aggregate rep numbers from.
 */
export const revenueForecasts = pgTable(
  "revenue_forecasts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** e.g. "2026-08" (month) or "2026-Q3" — caller-defined, not parsed. */
    periodLabel: text("period_label").notNull(),
    modelAmount: numeric("model_amount", { precision: 14, scale: 2 }).notNull(),
    currency: text("currency").notNull().default("USD"),
    managerAdjustedAmount: numeric("manager_adjusted_amount", { precision: 14, scale: 2 }),
    managerAdjustedReason: text("manager_adjusted_reason"),
    managerAdjustedBy: uuid("manager_adjusted_by").references(() => users.id, { onDelete: "set null" }),
    repCommittedAmount: numeric("rep_committed_amount", { precision: 14, scale: 2 }),
    repCommittedReason: text("rep_committed_reason"),
    repCommittedBy: uuid("rep_committed_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique().on(table.workspaceId, table.periodLabel),
    index("revenue_forecasts_workspace_idx").on(table.workspaceId),
  ]
);
