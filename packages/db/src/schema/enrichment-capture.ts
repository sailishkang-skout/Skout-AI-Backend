import { boolean, foreignKey, index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
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
