import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./crm.js";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

/**
 * COPS-11 — a workspace's health model (weights, thresholds, which factors count). Each change is
 * a new version; the latest version is the live one. Without a row the code defaults apply.
 */
export const copsHealthModels = pgTable(
  "cops_health_models",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    config: jsonb("config").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("cops_health_models_version_uq").on(t.workspaceId, t.version)]
);

/**
 * COPS-11 — one row per health computation of an account (Bible p.49): the score and state, each
 * dimension's score, and every contributing factor with its value, points, whether it is leading
 * or lagging, and a plain reason. Explanation and trend both read these rows.
 */
export const copsHealthScores = pgTable(
  "cops_health_scores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    score: integer("score").notNull(),
    state: text("state").notNull(),
    renewalRisk: text("renewal_risk").notNull(),
    dimensions: jsonb("dimensions").notNull(),
    factors: jsonb("factors").notNull(),
    modelVersion: integer("model_version").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("cops_health_scores_account_idx").on(t.workspaceId, t.accountId, t.computedAt)]
);
