import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { companies, deals } from "./crm.js";

/**
 * COPS-04 trial provisioning saga, owned by the operator workspace that provisions a customer
 * account. `idempotency_key` = sha256(account id + request Idempotency-Key); at most one succeeded
 * row per account (partial unique index in migration 0112).
 */
export const copsProvisionings = pgTable("cops_provisionings", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  accountId: uuid("account_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  opportunityId: uuid("opportunity_id")
    .notNull()
    .references(() => deals.id, { onDelete: "cascade" }),
  idempotencyKey: text("idempotency_key").notNull(),
  status: text("status").notNull().default("pending"),
  request: jsonb("request").notNull(),
  provisionedWorkspaceId: uuid("provisioned_workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
  inviteId: uuid("invite_id"),
  trialStartsAt: timestamp("trial_starts_at", { withTimezone: true }),
  trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
  requestedBy: uuid("requested_by"),
  lastError: text("last_error"),
  attempts: integer("attempts").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  durationMs: integer("duration_ms"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const copsProvisioningSteps = pgTable("cops_provisioning_steps", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  provisioningId: uuid("provisioning_id")
    .notNull()
    .references(() => copsProvisionings.id, { onDelete: "cascade" }),
  step: text("step").notNull(),
  position: integer("position").notNull(),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  result: jsonb("result"),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  durationMs: integer("duration_ms"),
});
