import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

/**
 * Workbooks V2 (WB2-010, PRD section 9): a live spreadsheet whose rows belong to the workbook and whose
 * every cell is its own database row. The legacy `enrichment_workbooks*` tables (schema/enrichment.ts)
 * are a separate system and stay as they are.
 *
 * Storage design from the WB2-003 spike:
 *  - `workbook_cells` is PARTITIONED BY HASH (workbook_id) into 64 partitions with fillfactor 80.
 *    Drizzle cannot express partitioning, so it lives only in the hand-written migration
 *    (drizzle/0173_workbook_v2_cells.sql). Do not regenerate that table from this file.
 *  - Postgres requires the partition column in the primary key, so the key is
 *    (workbook_id, row_id, column_id). (row_id, column_id) is still unique: row ids are unique across all
 *    workbooks, and the composite foreign key forces a cell's workbook_id to be its row's workbook.
 *  - `workbook_rows.id` is a bigint identity (not a uuid). Sequential ids are guessable, so every query
 *    must also filter by workbook_id, after checking the workbook belongs to the caller's workspace.
 *  - No secondary index on `workbook_cells`, so updates to a cell stay HOT. Never index `value`: a btree
 *    refuses entries over 2,704 bytes.
 *
 * Tenancy: only `workbooks` carries workspace_id. Every other table is reached through it, and composite
 * foreign keys stop a cell or run from joining the rows or columns of two different workbooks.
 */

/**
 * jsonb read exactly as stored. postgres-js already decodes jsonb, and drizzle's own `jsonb` then parses any
 * *string* it receives a second time, so a text cell "123" came back as the number 123, "true" as a boolean and
 * "{...}" as an object. Needed wherever the stored value may be a bare string.
 */
const exactJsonb = customType<{ data: unknown; driverData: unknown }>({
  dataType: () => "jsonb",
  toDriver: (value) => JSON.stringify(value),
  fromDriver: (value) => value,
});

export const WORKBOOK_COLUMN_TYPES_V2 = ["input", "enrichment", "ai", "formula", "action"] as const;
export type WorkbookColumnTypeV2 = (typeof WORKBOOK_COLUMN_TYPES_V2)[number];

export const WORKBOOK_CELL_STATES = ["queued", "running", "found", "not_found", "skipped", "error", "needs_input"] as const;
export type WorkbookCellState = (typeof WORKBOOK_CELL_STATES)[number];

export const WORKBOOK_RUN_SCOPES = ["all", "empty", "failed", "selected", "first10"] as const;
export type WorkbookRunScope = (typeof WORKBOOK_RUN_SCOPES)[number];

/** `skout`, `cache`, or `own_key:<provider>` for a provider the workspace connected itself. */
export type WorkbookFoundVia = "skout" | "cache" | `own_key:${string}`;

export const WORKBOOK_DEFAULT_ROW_LIMIT = 100_000;

export const workbooks = pgTable(
  "workbooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    rowCount: integer("row_count").notNull().default(0),
    /** Per workbook; CustomerOps may raise it for larger customers. */
    rowLimit: integer("row_limit").notNull().default(WORKBOOK_DEFAULT_ROW_LIMIT),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** Soft delete; restorable for 30 days. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /**
     * The legacy `enrichment_workbooks.id` this workbook was converted from. Deliberately not a foreign
     * key: the legacy tables are left untouched and are dropped later.
     */
    archivedSourceId: uuid("archived_source_id"),
  },
  (t) => [index("workbooks_workspace_idx").on(t.workspaceId).where(sql`${t.deletedAt} IS NULL`)]
);

export const workbookColumns = pgTable(
  "workbook_columns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workbookId: uuid("workbook_id")
      .notNull()
      .references(() => workbooks.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type").$type<WorkbookColumnTypeV2>().notNull(),
    /** e.g. find_email. Null for input and formula columns. */
    operation: text("operation"),
    /** Input mapping, waterfall settings, run condition, prompt, formula or action target. */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    position: integer("position").notNull(),
    width: integer("width").notNull().default(160),
    hidden: boolean("hidden").notNull().default(false),
    frozen: boolean("frozen").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("workbook_columns_workbook_id_id_key").on(t.workbookId, t.id),
    index("workbook_columns_workbook_position_idx").on(t.workbookId, t.position),
    check("workbook_columns_type_check", sql`${t.type} IN ('input','enrichment','ai','formula','action')`),
  ]
);

export const workbookRows = pgTable(
  "workbook_rows",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    workbookId: uuid("workbook_id")
      .notNull()
      .references(() => workbooks.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    /** Where the row came from (CSV file name, list, CRM, webhook...). */
    source: jsonb("source").$type<Record<string, unknown>>().notNull().default({}),
    /** Skout prospect id (text, as elsewhere in this schema), when the row is linked to one. */
    prospectId: text("prospect_id"),
    crmRef: jsonb("crm_ref").$type<Record<string, unknown>>(),
    suppressed: boolean("suppressed").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("workbook_rows_workbook_id_id_key").on(t.workbookId, t.id),
    index("workbook_rows_workbook_position_idx").on(t.workbookId, t.position),
    // A prospect is in a workbook once (WB2-021).
    uniqueIndex("workbook_rows_workbook_prospect_key").on(t.workbookId, t.prospectId).where(sql`${t.prospectId} IS NOT NULL`),
    // A CRM record is in a workbook once (WB2-023).
    uniqueIndex("workbook_rows_workbook_crm_ref_key")
      .on(t.workbookId, sql`(${t.crmRef} ->> 'provider')`, sql`coalesce(${t.crmRef} ->> 'accountId', '')`, sql`(${t.crmRef} ->> 'object')`, sql`(${t.crmRef} ->> 'id')`)
      .where(sql`(${t.crmRef} ->> 'object') IS NOT NULL`),
  ]
);

/**
 * One row per cell. Partitioned by hash(workbook_id) in the database: always filter by workbookId so a
 * query touches one partition. `internalProvenance` is server-only; for anything a browser can receive,
 * select `publicWorkbookCellColumns`.
 */
export const workbookCells = pgTable(
  "workbook_cells",
  {
    workbookId: uuid("workbook_id").notNull(),
    rowId: bigint("row_id", { mode: "number" }).notNull(),
    columnId: uuid("column_id").notNull(),
    value: exactJsonb("value"),
    state: text("state").$type<WorkbookCellState>().notNull(),
    confidence: real("confidence"),
    creditsCharged: integer("credits_charged").notNull().default(0),
    foundVia: text("found_via").$type<WorkbookFoundVia>(),
    /** For an email or phone copied from stored data: how it was verified (valid, catch_all, risky, unknown, unverified). */
    verification: text("verification"),
    /** SERVER ONLY: managed provider name and retrieval time. Never send to a browser (PRD SEC-3). */
    internalProvenance: jsonb("internal_provenance").$type<Record<string, unknown>>(),
    errorCode: text("error_code"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "workbook_cells_pkey", columns: [t.workbookId, t.rowId, t.columnId] }),
    foreignKey({
      name: "workbook_cells_row_fk",
      columns: [t.workbookId, t.rowId],
      foreignColumns: [workbookRows.workbookId, workbookRows.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "workbook_cells_column_fk",
      columns: [t.workbookId, t.columnId],
      foreignColumns: [workbookColumns.workbookId, workbookColumns.id],
    }).onDelete("cascade"),
    check("workbook_cells_state_check", sql`${t.state} IN ('queued','running','found','not_found','skipped','error','needs_input')`),
    // Also a guard for provider neutrality: a managed provider's name cannot be written here.
    check("workbook_cells_found_via_check", sql`${t.foundVia} IS NULL OR ${t.foundVia} IN ('skout','cache') OR ${t.foundVia} ~ '^own_key:[a-z0-9_.-]+$'`),
  ]
);

export const workbookRuns = pgTable(
  "workbook_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workbookId: uuid("workbook_id")
      .notNull()
      .references(() => workbooks.id, { onDelete: "cascade" }),
    columnId: uuid("column_id").notNull(),
    scope: text("scope").$type<WorkbookRunScope>().notNull(),
    rowFilter: jsonb("row_filter").$type<Record<string, unknown>>(),
    /** Set by the runner (WB2-050), e.g. queued, running, paused, completed, cancelled, failed. */
    status: text("status").notNull().default("queued"),
    maxCredits: integer("max_credits").notNull().default(0),
    creditsUsed: integer("credits_used").notNull().default(0),
    aiActionsUsed: integer("ai_actions_used").notNull().default(0),
    /** { queued, found, not_found, skipped, error } */
    counts: jsonb("counts").$type<Record<string, number>>().notNull().default({}),
    startedBy: uuid("started_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: "workbook_runs_column_fk",
      columns: [t.workbookId, t.columnId],
      foreignColumns: [workbookColumns.workbookId, workbookColumns.id],
    }).onDelete("cascade"),
    index("workbook_runs_workbook_created_idx").on(t.workbookId, t.createdAt),
    index("workbook_runs_workbook_column_idx").on(t.workbookId, t.columnId),
    check("workbook_runs_scope_check", sql`${t.scope} IN ('all','empty','failed','selected','first10')`),
  ]
);

export const WORKBOOK_IMPORT_STATUSES = ["awaiting_confirmation", "queued", "processing", "completed", "failed", "cancelled"] as const;
export type WorkbookImportStatus = (typeof WORKBOOK_IMPORT_STATUSES)[number];

export const WORKBOOK_IMPORT_ISSUE_KINDS = ["duplicate", "invalid", "malformed", "skipped", "over_limit"] as const;
export type WorkbookImportIssueKind = (typeof WORKBOOK_IMPORT_ISSUE_KINDS)[number];

export const workbookImports = pgTable(
  "workbook_imports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workbookId: uuid("workbook_id")
      .notNull()
      .references(() => workbooks.id, { onDelete: "cascade" }),
    /** csv, list, smart_list, search, paste, a CRM, apollo, google_sheets or webhook. */
    sourceType: text("source_type").notNull(),
    /** For a file import, one of WORKBOOK_IMPORT_STATUSES. */
    status: text("status").notNull().default("pending"),
    /** { total, processed, imported, duplicates, skipped, failed } */
    counts: jsonb("counts").$type<Record<string, number>>().notNull().default({}),
    /** Storage reference of the downloadable skipped-rows report. */
    errorReportFile: text("error_report_file"),
    /** Who started it; after confirmation, who confirmed it. */
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    fileName: text("file_name"),
    fileBytes: integer("file_bytes"),
    /** SERVER ONLY: where the uploaded file is stored. Null once it has been deleted. */
    fileKey: text("file_key"),
    /** What is shown before confirming: headers, the first rows and suggestions. Cleared afterwards. */
    preview: jsonb("preview").$type<Record<string, unknown>>(),
    /** The confirmed column mapping and deduplication key. */
    plan: jsonb("plan").$type<Record<string, unknown>>(),
    /** { code, message } for an import that failed or was cancelled. Safe to show. */
    error: jsonb("error").$type<{ code: string; message: string }>(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("workbook_imports_workbook_created_idx").on(t.workbookId, t.createdAt),
    // For the sweep that finds unfinished, abandoned and not-yet-cleaned-up imports.
    index("workbook_imports_unfinished_idx").on(t.status, t.updatedAt).where(sql`${t.finishedAt} IS NULL OR ${t.fileKey} IS NOT NULL`),
  ]
);

/**
 * Rows an import did not add, with why. Held only until the import finishes and its report file is written from
 * them; reached through the import, so through its workbook's workspace.
 */
export const workbookImportIssues = pgTable(
  "workbook_import_issues",
  {
    importId: uuid("import_id")
      .notNull()
      .references(() => workbookImports.id, { onDelete: "cascade" }),
    /** Data row number in the file, from 1. */
    record: integer("record").notNull(),
    /** Line of the file the row starts on. */
    line: integer("line").notNull(),
    kind: text("kind").$type<WorkbookImportIssueKind>().notNull(),
    reason: text("reason").notNull(),
    /** The row's values as they were in the file. */
    values: jsonb("values").$type<string[]>().notNull(),
  },
  (t) => [primaryKey({ name: "workbook_import_issues_pkey", columns: [t.importId, t.record] })]
);

/**
 * The prospects a list, smart list or search addition is working through, in order, fixed when it starts so a retry
 * resumes exactly where it stopped. Removed when the addition finishes.
 */
export const workbookImportItems = pgTable(
  "workbook_import_items",
  {
    importId: uuid("import_id")
      .notNull()
      .references(() => workbookImports.id, { onDelete: "cascade" }),
    /** Position in the selection, from 1. */
    seq: integer("seq").notNull(),
    prospectId: text("prospect_id").notNull(),
  },
  (t) => [primaryKey({ name: "workbook_import_items_pkey", columns: [t.importId, t.seq] })]
);

export const workbookViews = pgTable(
  "workbook_views",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workbookId: uuid("workbook_id")
      .notNull()
      .references(() => workbooks.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    filters: jsonb("filters").$type<unknown[]>().notNull().default([]),
    sorts: jsonb("sorts").$type<unknown[]>().notNull().default([]),
    /** Column ids hidden in this view. */
    hiddenColumns: jsonb("hidden_columns").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("workbook_views_workbook_idx").on(t.workbookId)]
);

export const workbookWebhooks = pgTable(
  "workbook_webhooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workbookId: uuid("workbook_id")
      .notNull()
      .references(() => workbooks.id, { onDelete: "cascade" }),
    /** Hash of the inbound token. The token itself is never stored. */
    tokenHash: text("token_hash").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // An inbound request is looked up by its token's hash, so it must name exactly one webhook.
    unique("workbook_webhooks_token_hash_key").on(t.tokenHash),
    index("workbook_webhooks_workbook_idx").on(t.workbookId),
  ]
);

/** Every cell column except `internalProvenance`: the selection for any browser-bound read. */
export const publicWorkbookCellColumns = {
  workbookId: workbookCells.workbookId,
  rowId: workbookCells.rowId,
  columnId: workbookCells.columnId,
  value: workbookCells.value,
  state: workbookCells.state,
  confidence: workbookCells.confidence,
  creditsCharged: workbookCells.creditsCharged,
  foundVia: workbookCells.foundVia,
  verification: workbookCells.verification,
  errorCode: workbookCells.errorCode,
  updatedAt: workbookCells.updatedAt,
} as const;

/** The full stored cell, including server-only provenance. Never use it as an API response type. */
export type WorkbookCellRecord = typeof workbookCells.$inferSelect;
/** A cell as it may leave the server. */
export type PublicWorkbookCell = Omit<WorkbookCellRecord, "internalProvenance">;
