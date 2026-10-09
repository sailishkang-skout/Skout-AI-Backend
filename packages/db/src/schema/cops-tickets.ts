import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { users } from "./users.js";
import { companies, contacts, deals } from "./crm.js";
import { copsOnboardingMilestones } from "./cops-onboarding.js";

/**
 * COPS-06 engineering tickets (Bible p.51-53). A ticket always belongs to an account and may link
 * to a contact, an opportunity and an onboarding milestone. `diagnostics` holds safe diagnostics
 * only (allowlisted in packages/shared cops-tickets); commercial and legal data is never copied in.
 * Operational incidents stay in `incidents` (COPS-12 extends that table).
 */
export const engineeringTickets = pgTable(
  "engineering_tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    opportunityId: uuid("opportunity_id").references(() => deals.id, { onDelete: "set null" }),
    milestoneId: uuid("milestone_id").references(() => copsOnboardingMilestones.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description"),
    /** bug | integration | data | performance | access | other */
    category: text("category").notNull().default("bug"),
    /** low | medium | high | critical */
    severity: text("severity").notNull().default("medium"),
    /** p1 | p2 | p3 | p4 */
    priority: text("priority").notNull().default("p3"),
    impact: text("impact"),
    affectedFeature: text("affected_feature"),
    /** production | sandbox | staging */
    environment: text("environment").notNull().default("production"),
    reproSteps: text("repro_steps"),
    logRefs: jsonb("log_refs").$type<string[]>().notNull().default([]),
    diagnostics: jsonb("diagnostics").$type<Record<string, unknown>>().notNull().default({}),
    /** new | triage | assigned | in_progress | testing | waiting_on_customer | resolved | verified | closed */
    status: text("status").notNull().default("new"),
    team: text("team"),
    assigneeId: uuid("assignee_id").references(() => users.id, { onDelete: "set null" }),
    /** smb | mid_market | enterprise, taken from the account when the ticket is created. */
    accountTier: text("account_tier").notNull().default("smb"),
    createdBy: uuid("created_by"),
    escalatedAt: timestamp("escalated_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("engineering_tickets_queue_idx").on(table.workspaceId, table.status, table.severity),
    index("engineering_tickets_account_idx").on(table.workspaceId, table.accountId),
    index("engineering_tickets_assignee_idx").on(table.workspaceId, table.assigneeId),
  ]
);

/**
 * Ticket comments. Visibility is a column with a CHECK (migration 0114), not a UI flag: every
 * customer-safe read path filters on it. A derived comment (AI summary) records its sources and
 * inherits their visibility.
 */
export const ticketComments = pgTable(
  "ticket_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => engineeringTickets.id, { onDelete: "cascade" }),
    /** internal | customer */
    visibility: text("visibility").notNull().default("internal"),
    /** note | update | ai_summary */
    kind: text("kind").notNull().default("note"),
    body: text("body").notNull(),
    sourceCommentIds: jsonb("source_comment_ids").$type<string[]>().notNull().default([]),
    authorId: uuid("author_id"),
    aiGenerated: boolean("ai_generated").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("ticket_comments_ticket_idx").on(table.workspaceId, table.ticketId, table.createdAt)]
);

/** Append-only status history: one row per transition, with who and why. */
export const ticketStatusHistory = pgTable(
  "ticket_status_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => engineeringTickets.id, { onDelete: "cascade" }),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    actorId: uuid("actor_id"),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("ticket_status_history_ticket_idx").on(table.workspaceId, table.ticketId, table.createdAt)]
);

/** CRM summary per account (open count, max severity), rewritten in the same transaction as the ticket change. */
export const ticketAccountSummaries = pgTable(
  "ticket_account_summaries",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    openCount: integer("open_count").notNull().default(0),
    maxSeverity: text("max_severity"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.accountId] })]
);
