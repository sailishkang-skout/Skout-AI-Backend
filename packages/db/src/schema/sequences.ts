import { sql } from "drizzle-orm";
import { boolean, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { inboxes } from "./inbox.js";
import { linkedinAccounts } from "./linkedin-accounts.js";
import { lists } from "./prospects.js";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

export const sequences = pgTable("sequences", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  status: text("status").notNull().default("draft"),
  /** manual | template | dexter */
  source: text("source").notNull().default("manual"),
  templateKey: text("template_key"),
  /** A default | B variant | C god mode — same engine, different surface */
  mode: text("mode").notNull().default("A"),
  /** Latest published version number (0 = never published). */
  currentVersion: integer("current_version").notNull().default(0),
  /** Set once a human explicitly approves a Mode C sequence — required before draft->active (spec §4-6). */
  modeCApprovedAt: timestamp("mode_c_approved_at", { withTimezone: true }),
  modeCApprovedBy: uuid("mode_c_approved_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sequenceSteps = pgTable(
  "sequence_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sequenceId: uuid("sequence_id")
      .notNull()
      .references(() => sequences.id, { onDelete: "cascade" }),
    stepOrder: integer("step_order").notNull(),
    stepType: text("step_type").notNull(),
    delayDays: integer("delay_days").notNull().default(0),
    /** minutes | hours | days | weeks — delayDays is the numeric value for this unit */
    delayUnit: text("delay_unit").notNull().default("days"),
    /** connect | message | inmail | like | follow — only meaningful when stepType is linkedin */
    linkedinAction: text("linkedin_action"),
    subject: text("subject"),
    bodyTemplate: text("body_template"),
    /** linkedin_connected | email_opened | email_clicked | email_replied | call_connected | icp_score_gte | … */
    conditionType: text("condition_type"),
    /** Compound AND/OR/NOT tree (spec §35). When set, evaluated instead of a single conditionType. */
    conditionExpression: jsonb("condition_expression"),
    conditionWaitDays: integer("condition_wait_days").notNull().default(2),
    yesNextStepId: uuid("yes_next_step_id"),
    noNextStepId: uuid("no_next_step_id"),
    parentStepId: uuid("parent_step_id"),
    /** yes | no | null (main trunk) */
    branch: text("branch"),
    goalLabel: text("goal_label"),
    /** Per-step retry policy (condition-engine spec §40) — previously hardcoded per channel
     * (LinkedIn/WhatsApp: fixed 60s, uncapped; email: BullMQ default). retryMaxAttempts caps
     * transient-failure retries so a step can never retry forever. */
    retryMaxAttempts: integer("retry_max_attempts").notNull().default(3),
    retryDelayMs: integer("retry_delay_ms").notNull().default(60_000),
    /** fixed | exponential — exponential multiplies retryDelayMs by 2^(attempt-1). */
    retryBackoffStrategy: text("retry_backoff_strategy").notNull().default("fixed"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.sequenceId, table.stepOrder)]
);

/** A/B/C content variants for a sendable step. A+B are default; C is god-mode extra test. */
export const sequenceStepVariants = pgTable(
  "sequence_step_variants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stepId: uuid("step_id")
      .notNull()
      .references(() => sequenceSteps.id, { onDelete: "cascade" }),
    variantKey: text("variant_key").notNull(),
    subject: text("subject"),
    bodyTemplate: text("body_template"),
    weight: integer("weight").notNull().default(50),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.stepId, table.variantKey)]
);

export const sequenceEnrollments = pgTable(
  "sequence_enrollments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sequenceId: uuid("sequence_id")
      .notNull()
      .references(() => sequences.id, { onDelete: "cascade" }),
    prospectId: text("prospect_id").notNull(),
    listId: uuid("list_id").references(() => lists.id, { onDelete: "set null" }),
    status: text("status").notNull().default("active"),
    /** A | B | C — persisted experiment assignment (spec §30) */
    experimentVariant: text("experiment_variant"),
    experimentId: uuid("experiment_id"),
    sequenceVersionId: uuid("sequence_version_id"),
    /** USER_STOPPED | POSITIVE_REPLY | … standardized stop codes (spec §71) */
    stopReason: text("stop_reason"),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    // Only one active enrollment per prospect/sequence — completed history is kept for analytics.
    uniqueIndex("sequence_enrollments_active_unique")
      .on(table.sequenceId, table.prospectId)
      .where(sql`${table.status} = 'active'`),
  ]
);

export const sequenceEnrollmentSteps = pgTable(
  "sequence_enrollment_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    enrollmentId: uuid("enrollment_id")
      .notNull()
      .references(() => sequenceEnrollments.id, { onDelete: "cascade" }),
    stepId: uuid("step_id")
      .notNull()
      .references(() => sequenceSteps.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    /** A | B | C — which variant was sent for this enrollment step */
    variantKey: text("variant_key"),
    inboxId: uuid("inbox_id").references(() => inboxes.id, { onDelete: "set null" }),
    /** Transient-failure retries so far — checked against the step's retryMaxAttempts so a
     * step can never retry forever (condition-engine spec §40's "never allow infinite retries"). */
    attemptCount: integer("attempt_count").notNull().default(0),
  },
  (table) => [unique().on(table.enrollmentId, table.stepId)]
);

/** Frozen published graph so in-flight enrollments do not pick up later edits (spec §32). */
export const sequenceVersions = pgTable(
  "sequence_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sequenceId: uuid("sequence_id")
      .notNull()
      .references(() => sequences.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: text("status").notNull().default("published"),
    snapshot: jsonb("snapshot").notNull().default({}),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.sequenceId, table.version)]
);

/** Strategy A/B experiment — deterministic 50/50 assignment (spec §29–31, §47–48). */
export const sequenceExperiments = pgTable("sequence_experiments", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  status: text("status").notNull().default("draft"),
  primaryMetric: text("primary_metric").notNull().default("positive_reply"),
  weightA: integer("weight_a").notNull().default(50),
  weightB: integer("weight_b").notNull().default(50),
  sequenceAId: uuid("sequence_a_id")
    .notNull()
    .references(() => sequences.id, { onDelete: "restrict" }),
  sequenceBId: uuid("sequence_b_id")
    .notNull()
    .references(() => sequences.id, { onDelete: "restrict" }),
  durationDays: integer("duration_days").notNull().default(30),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Explainable decision ledger (spec §45–46, §66–67). */
export const sequenceEvents = pgTable("sequence_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  sequenceId: uuid("sequence_id")
    .notNull()
    .references(() => sequences.id, { onDelete: "cascade" }),
  enrollmentId: uuid("enrollment_id").references(() => sequenceEnrollments.id, { onDelete: "cascade" }),
  sequenceVersionId: uuid("sequence_version_id"),
  prospectId: text("prospect_id"),
  stepId: uuid("step_id"),
  eventType: text("event_type").notNull(),
  variantKey: text("variant_key"),
  branch: text("branch"),
  result: text("result"),
  reason: text("reason"),
  evidence: jsonb("evidence").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Pending LinkedIn connect/message actions executed by the Chrome extension. */
export const linkedinOutreachJobs = pgTable("linkedin_outreach_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  enrollmentId: uuid("enrollment_id")
    .notNull()
    .references(() => sequenceEnrollments.id, { onDelete: "cascade" }),
  enrollmentStepId: uuid("enrollment_step_id")
    .notNull()
    .references(() => sequenceEnrollmentSteps.id, { onDelete: "cascade" })
    .unique(),
  prospectId: text("prospect_id").notNull(),
  linkedinUrl: text("linkedin_url").notNull(),
  action: text("action").notNull(),
  message: text("message"),
  status: text("status").notNull().default("pending"),
  failureReason: text("failure_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

/**
 * Dedicated LinkedIn connection-state tracking (condition-engine spec — replaces inferring
 * "accepted" from linkedin_outreach_jobs.status, which only ever reflected whether the invite
 * was successfully SENT, not whether the prospect actually accepted it).
 *
 * Populated by polling Unipile's first-degree relations list (see linkedin-connection.service.ts)
 * — Unipile has no reliable signal for an explicit decline, so status is honestly one of
 * pending → accepted, or pending → timed_out once conditionWaitDays elapses with no match
 * (matching condition-engine spec §19's own guidance not to treat non-acceptance as negative).
 */
export const linkedinConnections = pgTable(
  "linkedin_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    prospectId: text("prospect_id").notNull(),
    linkedinAccountId: uuid("linkedin_account_id")
      .notNull()
      .references(() => linkedinAccounts.id, { onDelete: "cascade" }),
    /** pending | accepted | timed_out */
    status: text("status").notNull().default("pending"),
    invitedAt: timestamp("invited_at", { withTimezone: true }).notNull().defaultNow(),
    /** Last time we actually polled Unipile — lets callers avoid re-polling on every condition
     * evaluation (see LINKEDIN_CONNECTION_RECHECK_MS in linkedin-connection.service.ts). */
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.workspaceId, table.prospectId)]
);

/** Open/click events for a sent sequence step email, attributed to enrollment + step. */
export const sequenceTrackingEvents = pgTable("sequence_tracking_events", {
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
  eventType: text("event_type").notNull(),
  url: text("url"),
  userAgent: text("user_agent"),
  ipAddress: text("ip_address"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
