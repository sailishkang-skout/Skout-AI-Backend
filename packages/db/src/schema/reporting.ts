import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { users } from "./users.js";
import { sequenceEnrollments, sequenceEnrollmentSteps, sequences } from "./sequences.js";

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

/**
 * §8.15 SP-10 — GTM learning cross-tab: one row per executed sequence-enrollment step
 * ("touchpoint"), joining ICP × signal × message × channel × outcome so the reporting UI can
 * slice by any combination without recomputing. A join-and-aggregate over 5 existing tables
 * (sequence_enrollment_steps, signals, sequence_steps/sequence_enrollments, sequence_enrollments,
 * inbox_threads/deals), not new instrumentation — see gtm-learning.service.ts for the query.
 *
 * Grain is per touchpoint, not per enrollment: channel and message variant are step-level, while
 * icp/signal/outcome are enrollment-level context duplicated across that enrollment's rows — the
 * same shape a marketing-attribution table uses ("of touchpoints sent via LinkedIn with variant B
 * while a hiring signal was active, what fraction of their enrollments eventually got a reply").
 *
 * Idempotent: unique(workspaceId, enrollmentStepId) lets the sweep re-run safely (ON CONFLICT
 * DO UPDATE), so a touchpoint's outcome/deal columns stay current as the enrollment progresses.
 */
export const gtmLearningOutcomes = pgTable(
  "gtm_learning_outcomes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    enrollmentId: uuid("enrollment_id")
      .notNull()
      .references(() => sequenceEnrollments.id, { onDelete: "cascade" }),
    enrollmentStepId: uuid("enrollment_step_id")
      .notNull()
      .references(() => sequenceEnrollmentSteps.id, { onDelete: "cascade" }),
    sequenceId: uuid("sequence_id")
      .notNull()
      .references(() => sequences.id, { onDelete: "cascade" }),
    prospectId: text("prospect_id").notNull(),
    touchpointAt: timestamp("touchpoint_at", { withTimezone: true }).notNull(),
    /** email | linkedin | whatsapp | call — from sequence_steps.step_type at touchpoint time. */
    channel: text("channel").notNull(),
    sequenceVersionId: uuid("sequence_version_id"),
    /** A | B | C content variant actually sent for this step. */
    variantKey: text("variant_key"),
    /** Latest prospect_scores row at/before touchpointAt — the ICP dimension. */
    icpScore: integer("icp_score"),
    icpPriority: text("icp_priority"),
    /** Highest-strength signal active (detected, not yet expired) at touchpointAt, on either the
     * prospect directly or its company. Null when no signal was active. */
    signalType: text("signal_type"),
    signalStrength: real("signal_strength"),
    /** Outcome dimensions, attributed at the enrollment level (duplicated across that
     * enrollment's touchpoint rows) — "qualified pipeline and revenue as primary outcomes". */
    replied: boolean("replied").notNull().default(false),
    meetingBooked: boolean("meeting_booked").notNull().default(false),
    opportunityCreated: boolean("opportunity_created").notNull().default(false),
    /** Sum of amounts of deals linked to this prospect's company that aren't closed-lost. */
    pipelineAmount: numeric("pipeline_amount", { precision: 14, scale: 2 }),
    /** Sum of amounts of deals linked to this prospect's company that are closed-won. */
    revenueAmount: numeric("revenue_amount", { precision: 14, scale: 2 }),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("gtm_learning_outcomes_step_unique").on(table.workspaceId, table.enrollmentStepId),
    index("gtm_learning_outcomes_workspace_channel_idx").on(table.workspaceId, table.channel),
    index("gtm_learning_outcomes_workspace_signal_idx").on(table.workspaceId, table.signalType),
    index("gtm_learning_outcomes_workspace_variant_idx").on(table.workspaceId, table.variantKey),
    index("gtm_learning_outcomes_workspace_sequence_idx").on(table.workspaceId, table.sequenceId),
  ]
);
