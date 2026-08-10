import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

/**
 * R20.3 — every AI next-best-action suggestion generated, whether or not the SDR acts on it.
 * `acceptedAt`/`acceptedAction` are set the moment a suggestion is turned into a real CRM
 * action ("create_task" | "enroll_sequence") — this is what makes an acceptance rate
 * measurable (accepted / total), not just a log of what the model said.
 */
export const nextBestActionSuggestions = pgTable(
  "next_best_action_suggestions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    actionType: text("action_type").notNull(),
    headline: text("headline").notNull(),
    rationale: text("rationale"),
    draftMessage: text("draft_message"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    /** "create_task" | "enroll_sequence" */
    acceptedAction: text("accepted_action"),
    /** taskId or sequenceId, depending on acceptedAction — free text to avoid a nullable dual-FK. */
    acceptedRefId: text("accepted_ref_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("nba_suggestions_workspace_id_idx").on(table.workspaceId),
    index("nba_suggestions_workspace_entity_idx").on(table.workspaceId, table.entityType, table.entityId),
  ]
);
