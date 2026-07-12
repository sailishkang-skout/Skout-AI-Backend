import { integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { inboxes } from "./inbox.js";
import { lists } from "./prospects.js";
import { workspaces } from "./workspaces.js";

export const sequences = pgTable("sequences", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  status: text("status").notNull().default("draft"),
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
    subject: text("subject"),
    bodyTemplate: text("body_template"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.sequenceId, table.stepOrder)]
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
    enrolledAt: timestamp("enrolled_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [unique().on(table.sequenceId, table.prospectId)]
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
    inboxId: uuid("inbox_id").references(() => inboxes.id, { onDelete: "set null" }),
  },
  (table) => [unique().on(table.enrollmentId, table.stepId)]
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
