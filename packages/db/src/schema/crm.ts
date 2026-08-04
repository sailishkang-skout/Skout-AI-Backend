import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    domain: text("domain"),
    industry: text("industry"),
    employeeCount: integer("employee_count"),
    revenue: numeric("revenue", { precision: 14, scale: 2 }),
    location: text("location"),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    status: text("status").notNull().default("active"),
    sourceProspectCompanyId: text("source_prospect_company_id"),
    /** R13.3 — per-field provenance: { [field]: { source, confidence?, setAt } }. "manual" wins forever. */
    fieldSources: jsonb("field_sources").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("companies_workspace_id_idx").on(table.workspaceId),
    index("companies_workspace_owner_idx").on(table.workspaceId, table.ownerId),
  ]
);

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    firstName: text("first_name").notNull(),
    lastName: text("last_name"),
    email: text("email"),
    phone: text("phone"),
    title: text("title"),
    linkedinUrl: text("linkedin_url"),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    lifecycleStage: text("lifecycle_stage").notNull().default("lead"),
    sourceProspectId: text("source_prospect_id"),
    /** R13.3 — per-field provenance: { [field]: { source, confidence?, setAt } }. "manual" wins forever. */
    fieldSources: jsonb("field_sources").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("contacts_workspace_id_idx").on(table.workspaceId),
    index("contacts_workspace_company_idx").on(table.workspaceId, table.companyId),
    index("contacts_workspace_email_idx").on(table.workspaceId, table.email),
  ]
);

export const pipelines = pgTable(
  "pipelines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [index("pipelines_workspace_id_idx").on(table.workspaceId)]
);

export const pipelineStages = pgTable(
  "pipeline_stages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pipelineId: uuid("pipeline_id")
      .notNull()
      .references(() => pipelines.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    orderIndex: integer("order_index").notNull(),
    probability: integer("probability").notNull().default(0),
    isClosedWon: boolean("is_closed_won").notNull().default(false),
    isClosedLost: boolean("is_closed_lost").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.pipelineId, table.orderIndex)]
);

export const deals = pgTable(
  "deals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    pipelineId: uuid("pipeline_id")
      .notNull()
      .references(() => pipelines.id),
    stageId: uuid("stage_id")
      .notNull()
      .references(() => pipelineStages.id),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }),
    currency: text("currency").notNull().default("USD"),
    closeDate: date("close_date"),
    probability: integer("probability"),
    status: text("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("deals_workspace_id_idx").on(table.workspaceId),
    index("deals_workspace_stage_idx").on(table.workspaceId, table.stageId),
    index("deals_workspace_status_idx").on(table.workspaceId, table.status),
  ]
);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    assignedTo: uuid("assigned_to").references(() => users.id, { onDelete: "set null" }),
    relatedEntityType: text("related_entity_type"),
    relatedEntityId: uuid("related_entity_id"),
    title: text("title").notNull(),
    dueDate: timestamp("due_date", { withTimezone: true }),
    priority: text("priority").notNull().default("medium"),
    status: text("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("tasks_workspace_id_idx").on(table.workspaceId),
    index("tasks_workspace_assignee_status_idx").on(table.workspaceId, table.assignedTo, table.status),
    index("tasks_workspace_entity_idx").on(
      table.workspaceId,
      table.relatedEntityType,
      table.relatedEntityId
    ),
  ]
);

export const activities = pgTable(
  "activities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    activityType: text("activity_type").notNull(),
    subject: text("subject"),
    body: text("body"),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("activities_workspace_entity_idx").on(table.workspaceId, table.entityType, table.entityId),
  ]
);

export const meetings = pgTable(
  "meetings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    dealId: uuid("deal_id").references(() => deals.id, { onDelete: "set null" }),
    organizerId: uuid("organizer_id").references(() => users.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    durationMinutes: integer("duration_minutes"),
    meetingType: text("meeting_type").notNull().default("call"),
    summary: text("summary"),
    outcome: text("outcome"),
    /** R16.2 — Zoom/Meet/Teams join link the bot dials into. */
    meetingUrl: text("meeting_url"),
    /** R16.2 — meeting-bot vendor's id for this session, for webhook correlation. */
    botExternalId: text("bot_external_id"),
    /** not_scheduled | scheduled | joining | in_call | completed | failed */
    botStatus: text("bot_status").notNull().default("not_scheduled"),
    recordingUrl: text("recording_url"),
    transcriptUrl: text("transcript_url"),
    /** Full transcript text, when the vendor sends it inline rather than as a fetchable URL. */
    transcript: text("transcript"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("meetings_workspace_id_idx").on(table.workspaceId),
    index("meetings_workspace_scheduled_idx").on(table.workspaceId, table.scheduledAt),
    index("meetings_workspace_deal_idx").on(table.workspaceId, table.dealId),
    index("meetings_bot_external_id_idx").on(table.botExternalId),
  ]
);
