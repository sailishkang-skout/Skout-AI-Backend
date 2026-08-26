import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

/**
 * §1.2 / D7 — Dexter Policy Gateway: workspace defaults + per-action overrides.
 * Modes: ask | auto | draft | approve (distinct from sequence Mode A/B/C).
 */
export const automationPolicies = pgTable(
  "automation_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Logical action key, e.g. dexter.enroll_list, sequence.activate, activation_rule.fire */
    actionKey: text("action_key").notNull(),
    mode: text("mode").notNull().default("ask"), // ask | auto | draft | approve
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("automation_policies_workspace_action_uidx").on(table.workspaceId, table.actionKey),
    index("automation_policies_workspace_idx").on(table.workspaceId),
  ]
);

export const policyDecisions = pgTable(
  "policy_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actionKey: text("action_key").notNull(),
    mode: text("mode").notNull(),
    outcome: text("outcome").notNull(), // allowed | denied | staged | proposed
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    detail: jsonb("detail").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("policy_decisions_workspace_created_idx").on(table.workspaceId, table.createdAt)]
);

/**
 * §1.2 / D14 — Decision-oriented views (not vanity dashboards).
 */
export const decisionViews = pgTable(
  "decision_views",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    kind: text("kind").notNull(), // next_best_action | forecast | competitive | custom
    status: text("status").notNull().default("open"), // open | decided | dismissed
    recommendation: text("recommendation"),
    options: jsonb("options").notNull().default([]),
    evidenceIds: jsonb("evidence_ids").notNull().default([]),
    expectedOutcome: jsonb("expected_outcome").notNull().default({}),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("decision_views_workspace_status_idx").on(table.workspaceId, table.status)]
);

/**
 * §1.2 / D15 — Observable async workflow runs (wraps/extends async_jobs).
 */
export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: text("status").notNull().default("pending"), // pending | running | completed | failed | cancelled
    correlationId: text("correlation_id"),
    asyncJobId: uuid("async_job_id"),
    steps: jsonb("steps").notNull().default([]),
    errorMessage: text("error_message"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("workflow_runs_workspace_created_idx").on(table.workspaceId, table.createdAt)]
);

/**
 * §10.4 — Dexter plan proposals (brief → plan → policy → invoke → outcome).
 */
export const dexterPlans = pgTable(
  "dexter_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    brief: text("brief").notNull(),
    proposal: jsonb("proposal").notNull().default({}),
    status: text("status").notNull().default("proposed"), // proposed | approved | invoked | learned
    policyMode: text("policy_mode"),
    policyDecisionId: uuid("policy_decision_id"),
    outcome: jsonb("outcome"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    invokedAt: timestamp("invoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("dexter_plans_workspace_status_idx").on(table.workspaceId, table.status)]
);

/**
 * §10.5 — LinkedIn AI voice: script → preview → handoff → manual confirm (no background send).
 */
export const linkedinVoiceHandoffs = pgTable(
  "linkedin_voice_handoffs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    prospectId: text("prospect_id").notNull(),
    scriptText: text("script_text").notNull(),
    voiceChoice: text("voice_choice").notNull().default("self"), // self | cloned | none
    regionalBriefPreview: text("regional_brief_preview"),
    evidenceId: uuid("evidence_id"),
    status: text("status").notNull().default("preview"), // preview | handed_off | confirmed
    handoffToken: text("handoff_token").notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("linkedin_voice_handoffs_token_uidx").on(table.handoffToken),
    index("linkedin_voice_handoffs_workspace_idx").on(table.workspaceId),
  ]
);
