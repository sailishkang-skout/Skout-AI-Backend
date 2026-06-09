import { integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
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
  },
  (table) => [unique().on(table.enrollmentId, table.stepId)]
);
