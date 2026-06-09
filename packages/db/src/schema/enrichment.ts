import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { prospectActivations } from "./prospects.js";
import { asyncJobs } from "./jobs.js";
import { workspaces } from "./workspaces.js";

export const enrichmentJobs = pgTable("enrichment_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  prospectId: text("prospect_id").notNull(),
  activationId: uuid("activation_id")
    .notNull()
    .references(() => prospectActivations.id, { onDelete: "cascade" }),
  asyncJobId: uuid("async_job_id").references(() => asyncJobs.id, { onDelete: "set null" }),
  status: text("status").notNull().default("pending"),
  trigger: text("trigger").notNull().default("manual"),
  fieldsRequested: text("fields_requested").array().notNull().default(["email", "company", "validation"]),
  errorMessage: text("error_message"),
  queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const enrichmentAttempts = pgTable(
  "enrichment_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    enrichmentJobId: uuid("enrichment_job_id")
      .notNull()
      .references(() => enrichmentJobs.id, { onDelete: "cascade" }),
    attemptOrder: integer("attempt_order").notNull(),
    provider: text("provider").notNull(),
    operation: text("operation").notNull(),
    status: text("status").notNull().default("pending"),
    requestInput: jsonb("request_input").notNull().default({}),
    responseOutput: jsonb("response_output"),
    latencyMs: integer("latency_ms"),
    errorMessage: text("error_message"),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [unique().on(table.enrichmentJobId, table.attemptOrder)]
);

export const enrichmentResults = pgTable("enrichment_results", {
  id: uuid("id").primaryKey().defaultRandom(),
  enrichmentJobId: uuid("enrichment_job_id")
    .notNull()
    .references(() => enrichmentJobs.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  prospectId: text("prospect_id").notNull(),
  fieldName: text("field_name").notNull(),
  fieldValue: text("field_value"),
  fieldValueJson: jsonb("field_value_json"),
  sourceProvider: text("source_provider").notNull(),
  confidence: numeric("confidence", { precision: 5, scale: 4 }),
  validationStatus: text("validation_status"),
  isPrimary: boolean("is_primary").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
