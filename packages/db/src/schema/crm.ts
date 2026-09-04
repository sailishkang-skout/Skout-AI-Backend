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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";
import { sequenceEnrollments, sequenceEnrollmentSteps } from "./sequences.js";

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
    /** §8.12 Task 29 — RetentionRulesService.classify() result against `status`, recomputed on
     * every status change in companies.service.ts's update(). Nullable/no default so existing
     * rows read as unclassified until their status next changes (no backfill; see migration). */
    retentionClassification: text("retention_classification"),
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
    /** §8.12 Task 29 — RetentionRulesService.classify() result against `lifecycleStage`,
     * recomputed on every lifecycle-stage change in contacts.service.ts's update(). Nullable/no
     * default so existing rows read as unclassified until their stage next changes. */
    retentionClassification: text("retention_classification"),
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
  (table) => [
    index("pipelines_workspace_id_idx").on(table.workspaceId),
    uniqueIndex("pipelines_workspace_default_unique_idx")
      .on(table.workspaceId)
      .where(sql`${table.isDefault} = true`),
  ]
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
    /** §8.12 CRM Intelligence — renewal-risk detection needs a contract end date to compare
     * against; didn't exist anywhere on companies/deals before this. Nullable: most deals (open,
     * not-yet-won, or won-without-a-tracked-term) have no contract end date to report. */
    contractEndDate: date("contract_end_date"),
    /** R16.3 — per-field provenance for LLM-extracted deal fields (amount/closeDate), same
     * pattern R13.3 built for contacts/companies. "manual" wins forever. */
    fieldSources: jsonb("field_sources").notNull().default({}),
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
    /** call | email | follow-up | custom (R21.1) — plain text, not a pg enum, so new types don't need a migration. */
    type: text("type").notNull().default("custom"),
    dueDate: timestamp("due_date", { withTimezone: true }),
    priority: text("priority").notNull().default("medium"),
    status: text("status").notNull().default("open"),
    /** R21.1 — recorded when a task enters either terminal status (done or skipped). */
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /**
     * R20.4 — set by the SDR after placing a "call" sequence-step call:
     * "connected" | "no_answer" | "voicemail" | "bad_number". Drives sequence branching —
     * see resolveCallDisposition() in sequence-enrollment.worker.ts, which treats this the same
     * way detectCadenceSignal() treats a reply/bounce.
     */
    disposition: text("disposition"),
    /**
     * Corpus prospectId (text hash, not the `relatedEntityId` uuid column above — see R14.1)
     * for "call" sequence-step tasks, so the task's "Call now" button can resolve a phone
     * number without a second round trip, and so disposition can be traced back to the
     * enrollment/step it should unblock.
     */
    prospectId: text("prospect_id"),
    sequenceEnrollmentId: uuid("sequence_enrollment_id").references(() => sequenceEnrollments.id, {
      onDelete: "set null",
    }),
    sequenceEnrollmentStepId: uuid("sequence_enrollment_step_id").references(() => sequenceEnrollmentSteps.id, {
      onDelete: "set null",
    }),
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
    /**
     * §8.12 / Task 19 — RetentionRulesService.classify()'s output ("marketing" | "contractual"),
     * stored at record() time. NULL means either "no active rule matched" (classify() returned
     * "unclassified") or "recorded before this column existed" — both read the same today; a
     * future pass could distinguish them if that turns out to matter.
     */
    retentionClassification: text("retention_classification"),
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
    /**
     * R16.2 — opt-in auto-join: when true, the meeting-auto-join worker schedules the bot on
     * its own (no manual "Schedule bot" click needed) once `meetingUrl` is set and the meeting
     * is within its scheduling lookahead window. Defaults from the workspace setting at create
     * time but can be overridden per meeting.
     */
    autoJoinBot: boolean("auto_join_bot").notNull().default(false),
    recordingUrl: text("recording_url"),
    transcriptUrl: text("transcript_url"),
    /** Full transcript text, when the vendor sends it inline rather than as a fetchable URL. */
    transcript: text("transcript"),
    /** Google Calendar — attendees invited when the meeting was scheduled via Google Meet. */
    invitees: jsonb("invitees").notNull().default([]),
    /** Google Calendar — this meeting's event id, for future updates/cancellation. */
    googleEventId: text("google_event_id"),
    googleCalendarId: text("google_calendar_id"),
    /** RFC 5545 UID — stable per meeting across all .ics invite revisions. */
    icsUid: text("ics_uid"),
    /** RFC 5545 SEQUENCE — increments each re-sent invite so calendar clients know a later revision supersedes an earlier one. */
    icsSequence: integer("ics_sequence").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("meetings_workspace_id_idx").on(table.workspaceId),
    index("meetings_workspace_scheduled_idx").on(table.workspaceId, table.scheduledAt),
    index("meetings_workspace_deal_idx").on(table.workspaceId, table.dealId),
    index("meetings_bot_external_id_idx").on(table.botExternalId),
    index("meetings_auto_join_due_idx").on(table.autoJoinBot, table.botStatus, table.scheduledAt),
    index("meetings_google_event_id_idx").on(table.googleEventId),
  ]
);

export const RSVP_STATUSES = ["needs-action", "accepted", "declined", "tentative"] as const;

/**
 * Tracks RSVP status per invitee for a meeting's .ics invite — a separate, isolated channel
 * from the Google Calendar integration above (calendarConnections/googleEventId), for meetings
 * that don't have an organizer with a connected Google Calendar.
 */
export const meetingAttendees = pgTable(
  "meeting_attendees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    rsvpStatus: text("rsvp_status").notNull().default("needs-action"),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("meeting_attendees_meeting_id_idx").on(table.meetingId),
    unique().on(table.meetingId, table.email),
  ]
);

export const calendarConnections = pgTable(
  "calendar_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    connectedEmail: text("connected_email").notNull(),
    /** AES-256-GCM encrypted at rest — see @skout/shared's integration-crypto. */
    oauthAccessTokenEncrypted: text("oauth_access_token_encrypted").notNull(),
    oauthRefreshTokenEncrypted: text("oauth_refresh_token_encrypted"),
    oauthTokenExpiresAt: timestamp("oauth_token_expires_at", { withTimezone: true }),
    oauthScope: text("oauth_scope"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.workspaceId, table.userId)]
);
