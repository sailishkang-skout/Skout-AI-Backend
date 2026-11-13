import { sql } from "drizzle-orm";
import { boolean, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";
import { companies, contacts } from "./crm.js";

export const companyPersonDiscoveries = pgTable(
  "company_person_discoveries",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull(),
    contactId: uuid("contact_id").notNull(),
    source: text("source").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.companyId, table.contactId] }),
    foreignKey({
      name: "company_person_discoveries_company_workspace_fk",
      columns: [table.workspaceId, table.companyId],
      foreignColumns: [companies.workspaceId, companies.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "company_person_discoveries_contact_workspace_fk",
      columns: [table.workspaceId, table.contactId],
      foreignColumns: [contacts.workspaceId, contacts.id],
    }).onDelete("cascade"),
    index("company_person_discoveries_workspace_contact_idx").on(table.workspaceId, table.contactId),
  ]
);

export const enrichmentSnapshots = pgTable(
  "enrichment_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    entityType: text("entity_type", { enum: ["person", "company"] }).notNull(),
    entityId: text("entity_id").notNull(),
    fieldHashes: jsonb("field_hashes").notNull().default({}),
    rawData: jsonb("raw_data").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    capturedVia: text("captured_via", {
      enum: ["EXTENSION", "ENRICHMENT_API", "MANUAL_IMPORT"],
    }).notNull(),
    capturedBy: uuid("captured_by").references(() => users.id, { onDelete: "set null" }),
  },
  (table) => [
    index("enrichment_snapshots_workspace_entity_idx").on(
      table.workspaceId,
      table.entityType,
      table.entityId,
      table.capturedAt
    ),
  ]
);

export const enrichmentChangeEvents = pgTable(
  "enrichment_change_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    entityType: text("entity_type", { enum: ["person", "company"] }).notNull(),
    entityId: text("entity_id").notNull(),
    field: text("field").notNull(),
    changeType: text("change_type", {
      enum: ["FIELD_UPDATED", "FIELD_ADDED", "FIELD_REMOVED"],
    }).notNull(),
    oldValue: jsonb("old_value"),
    newValue: jsonb("new_value"),
    isJobChange: boolean("is_job_change").notNull().default(false),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    /** ENR-03 — a job change is surfaced for human review; it never triggers outreach by itself. */
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
  },
  (table) => [
    index("enrichment_change_events_workspace_detected_idx").on(table.workspaceId, table.detectedAt),
    index("enrichment_change_events_workspace_job_change_idx").on(
      table.workspaceId,
      table.isJobChange,
      table.detectedAt
    ),
    index("enrichment_change_events_workspace_entity_idx").on(
      table.workspaceId,
      table.entityType,
      table.entityId
    ),
  ]
);

/**
 * ENR-02 — canonical LinkedIn identity keys for workspace CRM records. Several keys may point
 * at one record (a Sales Navigator lead that later exposes its public `/in/` URL keeps both;
 * a company keeps its vanity slug and its numeric member id), which is what makes repeated
 * captures idempotent without deriving one key from another.
 *   person keys:  `in:<public-id>` | `sales-lead:<opaque-id>`
 *   company keys: `company:<public-id>` | `company-member:<member-id>`
 */
export const enrichmentIdentities = pgTable(
  "enrichment_identities",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    entityType: text("entity_type", { enum: ["person", "company"] }).notNull(),
    canonicalKey: text("canonical_key").notNull(),
    /** contacts.id for a person, companies.id for a company. */
    entityId: uuid("entity_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.entityType, table.canonicalKey] }),
    index("enrichment_identities_workspace_entity_idx").on(table.workspaceId, table.entityType, table.entityId),
  ]
);

/**
 * ENR-02 — one row per user-started capture (who, when, source, counts, terminal status).
 * The extension only reports success once a run reaches a terminal status here.
 */
export const enrichmentCaptureRuns = pgTable(
  "enrichment_capture_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    kind: text("kind", { enum: ["person", "company", "sales_search"] }).notNull(),
    sourceUrl: text("source_url"),
    /** Client-generated id; a retried start returns the same run instead of a second one. */
    clientRunId: text("client_run_id"),
    status: text("status", {
      enum: ["running", "completed", "stopped", "failed", "halted", "rejected"],
    })
      .notNull()
      .default("running"),
    pagesRead: integer("pages_read").notNull().default(0),
    leadsReceived: integer("leads_received").notNull().default(0),
    leadsCreated: integer("leads_created").notNull().default(0),
    leadsMerged: integer("leads_merged").notNull().default(0),
    leadsRejected: integer("leads_rejected").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("enrichment_capture_runs_workspace_started_idx").on(table.workspaceId, table.startedAt),
    index("enrichment_capture_runs_workspace_user_started_idx").on(table.workspaceId, table.userId, table.startedAt),
    uniqueIndex("enrichment_capture_runs_client_run_unique_idx")
      .on(table.workspaceId, table.userId, table.clientRunId)
      .where(sql`${table.clientRunId} IS NOT NULL`),
  ]
);

/**
 * Companies whose people discovery stopped at a batch limit (one batch is at most 250 people)
 * and still has result pages left. The extension reports each saved batch here, so the web
 * app can list them under LinkedIn Enrichment → Capture queue and the user can continue later.
 */
export const enrichmentCaptureQueue = pgTable(
  "enrichment_capture_queue",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    companyPublicId: text("company_public_id").notNull(),
    companyName: text("company_name"),
    sourceUrl: text("source_url").notNull(),
    pagesRead: integer("pages_read").notNull().default(0),
    peopleFound: integer("people_found").notNull().default(0),
    expectedPeople: integer("expected_people"),
    batches: integer("batches").notNull().default(0),
    complete: boolean("complete").notNull().default(false),
    stopReason: text("stop_reason"),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.companyPublicId] }),
    index("enrichment_capture_queue_workspace_updated_idx").on(table.workspaceId, table.complete, table.updatedAt),
  ]
);
