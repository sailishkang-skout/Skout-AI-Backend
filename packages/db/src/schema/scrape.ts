import { bigint, index, integer, jsonb, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
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

/** Point-in-time firmographic snapshots for headcount / hiring growth (E5.3). */
export const companySnapshots = pgTable(
  "company_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    domain: text("domain").notNull(),
    employeeCount: integer("employee_count"),
    openJobs: integer("open_jobs"),
    annualRevenue: bigint("annual_revenue", { mode: "number" }),
    scrapedAt: timestamp("scraped_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("company_snapshots_domain_idx").on(table.domain),
    index("company_snapshots_domain_scraped_idx").on(table.domain, table.scrapedAt),
  ]
);

/**
 * Unified signal store (R11.2) — one typed timeline row per detected company-level buying/intent
 * signal (hiring, funding, leadership change, tech-stack change, ...), replacing the ad-hoc
 * OpenSearch-only `ProspectDocument.signals[]` nested field as the source of truth. `entityId` is
 * the corpus `companyId` hash (see packages/shared/src/identity.ts) — not a Postgres FK, since the
 * referenced companies live in OpenSearch, not this database (same pattern as `companySnapshots`
 * above, keyed by domain).
 */
export const signals = pgTable(
  "signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityType: text("entity_type").notNull().default("company"),
    entityId: text("entity_id").notNull(),
    /** recent_hiring | recent_funding | leadership_change | tech_adoption | headcount_growth | ... */
    signalType: text("signal_type").notNull(),
    value: jsonb("value").notNull().default({}),
    /** 0–1 confidence, matches the existing fieldProvenanceSchema range. */
    confidence: real("confidence"),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
    source: text("source"),
    provenance: jsonb("provenance").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("signals_entity_idx").on(table.entityType, table.entityId, table.detectedAt),
    index("signals_type_idx").on(table.signalType),
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
