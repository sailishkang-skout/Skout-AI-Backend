import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

/**
 * Corpus-build scrape jobs (Tier 1). Tracks orchestrator → bots → cleaner →
 * ingestor lifecycle and lineage counts. Distinct from `enrichment_jobs`
 * (Tier 2, per-prospect activation). See docs/data-enrichment-strategy.md.
 */
export const scrapeJobs = pgTable(
  "scrape_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source").notNull(),
    status: text("status").notNull().default("queued"),
    trigger: text("trigger").notNull().default("schedule"),
    seeds: text("seeds").array().notNull().default([]),
    options: jsonb("options").notNull().default({}),
    rawS3Key: text("raw_s3_key"),
    cleanS3Key: text("clean_s3_key"),
    manifestS3Key: text("manifest_s3_key"),
    rawCount: integer("raw_count").notNull().default(0),
    cleanCount: integer("clean_count").notNull().default(0),
    quarantinedCount: integer("quarantined_count").notNull().default(0),
    ingestedCount: integer("ingested_count").notNull().default(0),
    skippedDuplicateCount: integer("skipped_duplicate_count").notNull().default(0),
    errorMessage: text("error_message"),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("scrape_jobs_status_idx").on(table.status),
    index("scrape_jobs_source_idx").on(table.source),
  ]
);

/** Dynamic OpenSearch filter sets saved per workspace (strategy §3.6 smart lists). */
export const smartLists = pgTable("smart_lists", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** SearchFilters JSON — re-run against OpenSearch on demand. */
  filters: jsonb("filters").notNull().default({}),
  lastRunCount: integer("last_run_count"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
