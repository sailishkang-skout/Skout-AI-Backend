import { boolean, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

/**
 * R13.4 — Auto-activation rules: "prospect score >= threshold (+ optional signal) -> action".
 * Capped at 5 active rules per workspace at the application layer (see
 * ActivationRulesService.create), not in the DB — a guardrail against runaway automation.
 */
export const activationRules = pgTable(
  "activation_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    scoreThreshold: integer("score_threshold").notNull(),
    /** e.g. "hiring", "funding", "tech_adopted" — matched against the R11 signal store once it exists. Optional. */
    signalType: text("signal_type"),
    /** "activate" | "add_to_list" | "enroll_sequence" */
    targetAction: text("target_action").notNull(),
    /** listId or sequenceId, depending on targetAction. Null for "activate". */
    targetId: text("target_id"),
    enabled: boolean("enabled").notNull().default(true),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("activation_rules_workspace_id_idx").on(table.workspaceId),
    index("activation_rules_workspace_enabled_idx").on(table.workspaceId, table.enabled),
  ]
);

/** Audit trail of rule firings — required so an auto-action can be manually reversed (R13.4 AC). */
export const activationRuleRuns = pgTable(
  "activation_rule_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => activationRules.id, { onDelete: "cascade" }),
    prospectId: text("prospect_id").notNull(),
    actionTaken: text("action_taken").notNull(),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("activation_rule_runs_workspace_id_idx").on(table.workspaceId),
    index("activation_rule_runs_rule_id_idx").on(table.ruleId),
  ]
);
