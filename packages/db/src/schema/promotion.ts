import { index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

export const PROMOTION_CANDIDATE_STATUSES = ["pending", "promoted", "dismissed"] as const;

/**
 * One row per prospect that has ever crossed a workspace's `dealPromotionThreshold`.
 * Re-scoring an already-`pending` candidate updates its `score` in place rather than
 * inserting a second row — see the unique constraint below.
 */
export const promotionCandidates = pgTable(
  "promotion_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    prospectId: text("prospect_id").notNull(),
    score: integer("score").notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique().on(table.workspaceId, table.prospectId),
    index("promotion_candidates_workspace_status_idx").on(table.workspaceId, table.status),
  ]
);
