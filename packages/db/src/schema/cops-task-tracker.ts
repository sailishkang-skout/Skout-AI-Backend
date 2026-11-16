import { date, doublePrecision, index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { users } from "./users.js";
import { companies } from "./crm.js";

/** Work tracker (GitHub Projects / Jira style) for every Skout department. Migration 0157. */
export const TRACKER_DEPARTMENTS = ["sales", "customer_success", "engineering", "product", "finance", "legal", "marketing", "operations", "other"] as const;
export const TRACKER_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked", "done"] as const;
export const TRACKER_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export const TRACKER_TYPES = ["task", "bug", "story", "request"] as const;

/** A board for one team: key ENG, issues ENG-1, ENG-2... */
export const copsTrackerProjects = pgTable(
  "cops_tracker_projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    department: text("department").notNull(),
    description: text("description"),
    /** The number the next issue gets (ENG-<next_number>). */
    nextNumber: integer("next_number").notNull().default(1),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [unique("cops_tracker_projects_key_unique").on(t.workspaceId, t.key)]
);

export const copsTrackerIssues = pgTable(
  "cops_tracker_issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => copsTrackerProjects.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    type: text("type").notNull().default("task"),
    status: text("status").notNull().default("todo"),
    priority: text("priority").notNull().default("medium"),
    assigneeId: uuid("assignee_id").references(() => users.id, { onDelete: "set null" }),
    reporterId: uuid("reporter_id").references(() => users.id, { onDelete: "set null" }),
    labels: text("labels").array().notNull().default([]),
    dueDate: date("due_date"),
    /** The customer this work is for, when there is one. */
    accountId: uuid("account_id").references(() => companies.id, { onDelete: "set null" }),
    parentId: uuid("parent_id"),
    /** Order inside its status column on the board. */
    position: doublePrecision("position").notNull().default(0),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("cops_tracker_issues_number_unique").on(t.projectId, t.number),
    index("cops_tracker_issues_board_idx").on(t.workspaceId, t.projectId, t.status, t.position),
    index("cops_tracker_issues_assignee_idx").on(t.workspaceId, t.assigneeId, t.status),
  ]
);

export const copsTrackerComments = pgTable(
  "cops_tracker_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => copsTrackerIssues.id, { onDelete: "cascade" }),
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("cops_tracker_comments_issue_idx").on(t.issueId, t.createdAt)]
);
