import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

/**
 * §8.14 — Workflow Studio's automation graphs. Named "automation" (not "workflow") to avoid
 * colliding with §1.2/D15's pre-existing `workflowRuns` table (dexter-platform.ts) and its
 * `/api/v1/workflows/runs*` routes, which wrap arbitrary async jobs for observability — a
 * different, narrower concept than a user-authored automation graph and its executions.
 */
export const automations = pgTable(
  "automations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("draft"), // draft | active | archived
    currentVersion: integer("current_version").notNull().default(0),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("automations_workspace_idx").on(table.workspaceId)]
);

/** An immutable, published-or-draft snapshot of an automation's graph. */
export const automationVersions = pgTable(
  "automation_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    /** { nodes: AutomationNode[]; edges: AutomationEdge[] } — see automation-graph.ts. */
    graph: jsonb("graph").notNull(),
    status: text("status").notNull().default("draft"), // draft | published | archived
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedBy: uuid("published_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("automation_versions_automation_version_uidx").on(table.automationId, table.version),
    index("automation_versions_automation_idx").on(table.automationId),
  ]
);

/** One execution of a published (or draft, for simulation) automation version. */
export const automationRuns = pgTable(
  "automation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    automationVersionId: uuid("automation_version_id")
      .notNull()
      .references(() => automationVersions.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    triggerType: text("trigger_type").notNull(), // event | webhook | schedule | manual
    triggerRef: text("trigger_ref"),
    correlationId: uuid("correlation_id").notNull().defaultRandom(),
    status: text("status").notNull().default("pending"), // pending|running|awaiting_approval|succeeded|failed|cancelled
    idempotencyKey: text("idempotency_key"),
    isSimulation: boolean("is_simulation").notNull().default(false),
    businessResult: jsonb("business_result"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("automation_runs_automation_idx").on(table.automationId, table.createdAt),
    uniqueIndex("automation_runs_idempotency_uidx").on(table.automationId, table.idempotencyKey),
  ]
);

/** One node execution within a run — the claim/heartbeat/complete/fail unit of work, backed by
 * @skout/shared's execution-intent library. */
export const automationRunSteps = pgTable(
  "automation_run_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    automationRunId: uuid("automation_run_id")
      .notNull()
      .references(() => automationRuns.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    status: text("status").notNull().default("pending"), // pending|claimed|running|succeeded|failed|skipped|outcome_unknown
    input: jsonb("input"),
    output: jsonb("output"),
    error: text("error"),
    idempotencyKey: text("idempotency_key").notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("automation_run_steps_run_idx").on(table.automationRunId, table.status),
    uniqueIndex("automation_run_steps_idempotency_uidx").on(table.idempotencyKey),
  ]
);

/** Encrypted credentials an automation's generic HTTP node can reference by id. */
export const automationSecrets = pgTable(
  "automation_secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    encryptedValue: text("encrypted_value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("automation_secrets_workspace_idx").on(table.workspaceId)]
);
