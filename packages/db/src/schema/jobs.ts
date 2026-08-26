import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

export const asyncJobs = pgTable("async_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  jobType: text("job_type").notNull(),
  status: text("status").notNull().default("pending"),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  payload: jsonb("payload").notNull().default({}),
  result: jsonb("result"),
  errorMessage: text("error_message"),
  /** 0-100, null until the job reports its first progress tick. */
  progress: integer("progress"),
  bullmqJobId: text("bullmq_job_id"),
  queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});
