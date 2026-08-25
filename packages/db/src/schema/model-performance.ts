import { index, jsonb, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

/**
 * 8.15 Ask — "model/prompt performance is tracked." An append-only log of AI decisions where a
 * human later accepted or overrode the suggestion — the one signal genuinely missing from
 * existing tables (inbox_threads clears suggestedTag once a manual review resolves, so the
 * comparison is lost unless captured at resolution time). The other tracked dimensions
 * (precision, calibration, downstream outcome, fairness/drift) are computed live from existing
 * tables (prospect_scores, prospect_activations, inbox_threads, deals) — no event log needed
 * there, same "live rollup over existing data" shape as cro-summary.service.ts.
 */
export const modelDecisionEvents = pgTable(
  "model_decision_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** "reply_classification" today; open to other AI decision surfaces later. */
    surface: text("surface").notNull(),
    suggestedValue: text("suggested_value"),
    /** "accepted" | "overridden" */
    outcome: text("outcome").notNull(),
    confidence: real("confidence"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("model_decision_events_workspace_idx").on(table.workspaceId, table.surface, table.createdAt)]
);
