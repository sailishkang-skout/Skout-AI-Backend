import {
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

export const prospectActivations = pgTable(
  "prospect_activations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    prospectId: text("prospect_id").notNull(),
    companyId: text("company_id").notNull(),
    snapshot: jsonb("snapshot").notNull().default({}),
    recordVersion: integer("record_version").notNull().default(1),
    activatedAt: timestamp("activated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.workspaceId, table.prospectId)]
);

export const lists = pgTable("lists", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const listMembers = pgTable(
  "list_members",
  {
    listId: uuid("list_id")
      .notNull()
      .references(() => lists.id, { onDelete: "cascade" }),
    prospectId: text("prospect_id").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.listId, table.prospectId] })]
);

/**
 * Latest email deliverability verdict per prospect (from a PAL verifier — MillionVerifier,
 * ZeroBounce, NeverBounce, Hunter). Used to warn/exclude undeliverable addresses before a
 * bulk send. Keyed by prospect so it is reusable across lists and the send pipeline.
 */
export const emailVerifications = pgTable(
  "email_verifications",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    prospectId: text("prospect_id").notNull(),
    email: text("email").notNull(),
    // valid | invalid | catch_all | risky | unknown | no_email
    status: text("status").notNull(),
    deliverabilityScore: integer("deliverability_score").notNull().default(0),
    catchAll: boolean("catch_all").notNull().default(false),
    risky: boolean("risky").notNull().default(false),
    provider: text("provider"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.prospectId] })]
);

export const prospectScores = pgTable(
  "prospect_scores",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    prospectId: text("prospect_id").notNull(),
    score: integer("score").notNull(),
    reasoning: text("reasoning"),
    priority: text("priority"),
    scoredAt: timestamp("scored_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.prospectId] })]
);
