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
  batchId: uuid("batch_id"),
  status: text("status").notNull().default("pending"),
  trigger: text("trigger").notNull().default("manual"),
  fieldsRequested: text("fields_requested").array().notNull().default(["email", "company", "validation"]),
  creditsUsed: integer("credits_used").notNull().default(0),
  errorMessage: text("error_message"),
  queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const enrichmentBatches = pgTable("enrichment_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  listId: uuid("list_id"),
  total: integer("total").notNull().default(0),
  done: integer("done").notNull().default(0),
  failed: integer("failed").notNull().default(0),
  status: text("status").notNull().default("queued"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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

/**
 * A reusable, named enrichment configuration (8.3) — waterfall fields, an optional
 * per-run credit budget, and an email quality threshold. Runs (below) execute a
 * workbook against a target set of prospects; the workbook itself is just config,
 * never touched by execution.
 */
export const enrichmentWorkbooks = pgTable("enrichment_workbooks", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** EnrichField[] — which waterfall steps a run of this workbook performs. */
  fields: text("fields").array().notNull().default(["company", "email", "validation"]),
  /** 0-1 minimum email-finder confidence to accept before trying the next provider. Null = accept first hit (current engine default). */
  emailQualityThreshold: numeric("email_quality_threshold", { precision: 3, scale: 2 }),
  /** Credits a single run of this workbook may spend. Null = no workbook-specific cap beyond the workspace balance. */
  budgetCreditsPerRun: integer("budget_credits_per_run"),
  /** "draft" | "active" — promoting to production use is an explicit step (activatedAt below), never implicit. */
  status: text("status").notNull().default("draft"),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * §8.3 Task ADI-12 — a user-defined column layered on top of a workbook's fixed 4 fields.
 * Only two `columnType`s exist for this cut: "derived" (a `{{key}}` string-template
 * referencing another column, computed in-process) and "ai_research" (a per-row LLM call).
 * See docs/superpowers/specs/2026-09-05-workbook-flexible-columns-design.md — this
 * deliberately does not touch packages/pal's waterfall engine or the `fields` column above;
 * it's a second, parallel computation pass over the same rows.
 */
export const workbookColumnDefinitions = pgTable(
  "workbook_column_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    workbookId: uuid("workbook_id")
      .notNull()
      .references(() => enrichmentWorkbooks.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    /** "derived" | "ai_research" */
    columnType: text("column_type").notNull(),
    /** derived: { template: string }. ai_research: { promptTemplate: string }. */
    config: jsonb("config").notNull(),
    orderIndex: integer("order_index").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.workbookId, table.key)]
);

/**
 * §8.3 Task ADI-12 — one row per (run, column, prospect): the "cell". Run-scoped rather
 * than workbook-scoped, mirroring enrichmentResults being job-scoped — a rerun produces
 * fresh values instead of mutating history, matching this codebase's append-only
 * enrichment-output convention. `evidenceId` is required (non-null) whenever an
 * "ai_research" column succeeds — see pinAiClaim in workbook-column-compute.service.ts.
 */
export const workbookColumnValues = pgTable(
  "workbook_column_values",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    workbookRunId: uuid("workbook_run_id")
      .notNull()
      .references(() => enrichmentWorkbookRuns.id, { onDelete: "cascade" }),
    columnDefinitionId: uuid("column_definition_id")
      .notNull()
      .references(() => workbookColumnDefinitions.id, { onDelete: "cascade" }),
    prospectId: text("prospect_id").notNull(),
    /** "pending" | "succeeded" | "failed" */
    status: text("status").notNull().default("pending"),
    value: text("value"),
    evidenceId: uuid("evidence_id"),
    error: text("error"),
    computedAt: timestamp("computed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("workbook_column_values_run_col_prospect_uidx").on(
      table.workbookRunId,
      table.columnDefinitionId,
      table.prospectId
    ),
  ]
);

/**
 * One execution of a workbook against a resolved set of prospects. Row-level work is
 * tracked by the existing enrichmentJobs/enrichmentBatches tables (batchId below) —
 * this table is the run-level envelope: mode, target set, budget, and pause/resume state.
 */
export const enrichmentWorkbookRuns = pgTable("enrichment_workbook_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workbookId: uuid("workbook_id")
    .notNull()
    .references(() => enrichmentWorkbooks.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  listId: uuid("list_id").notNull(),
  /** "sample" | "selected" | "changed_rows" | "scheduled" (scheduled = the full list). */
  mode: text("mode").notNull(),
  /** Resolved prospect ids this run targets, fixed at start so pause/resume/rerun stay consistent. */
  targetProspectIds: jsonb("target_prospect_ids").notNull().default([]),
  batchId: uuid("batch_id").references(() => enrichmentBatches.id, { onDelete: "set null" }),
  /** "pending" | "running" | "paused" | "completed" | "partial" | "failed" | "cancelled" */
  status: text("status").notNull().default("pending"),
  totalRows: integer("total_rows").notNull().default(0),
  processedRows: integer("processed_rows").notNull().default(0),
  succeededRows: integer("succeeded_rows").notNull().default(0),
  failedRows: integer("failed_rows").notNull().default(0),
  creditsBudget: integer("credits_budget"),
  creditsUsed: integer("credits_used").notNull().default(0),
  /** Set when this run is a "rerun failed cells" of an earlier run — never re-runs the whole workbook. */
  rerunOfRunId: uuid("rerun_of_run_id"),
  errorMessage: text("error_message"),
  queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  pausedAt: timestamp("paused_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});
