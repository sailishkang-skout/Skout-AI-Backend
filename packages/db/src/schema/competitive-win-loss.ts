import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

/** §2 — durable win/loss deal rows (min 4 required before Regional TAM marketing gate clears). */
export const competitiveWinLossDeals = pgTable(
  "competitive_win_loss_deals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    accountName: text("account_name").notNull(),
    outcome: text("outcome").notNull(), // won | lost
    competitors: text("competitors"),
    differentiatorCited: text("differentiator_cited"),
    evidenceOrRegionalMaterial: boolean("evidence_or_regional_material").notNull().default(false),
    notes: text("notes"),
    recordedBy: uuid("recorded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("competitive_win_loss_deals_workspace_idx").on(table.workspaceId)]
);

export const competitiveWinLossOwners = pgTable(
  "competitive_win_loss_owners",
  {
    workspaceId: uuid("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    productOwnerUserId: uuid("product_owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  }
);
