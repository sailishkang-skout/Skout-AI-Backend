import { boolean, index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";

/**
 * §5.1 Core entities (Wave 2, now shipped) — ModelVersion/PromptVersion, "once Dexter's
 * orchestrator needs to pin versions for its audit trail" per the vision doc's own completion
 * plan. Platform-wide, not workspace-scoped — a model/prompt version is a deployment artifact
 * shared across every workspace, not per-tenant data. Ships the schema + a version-pinning
 * shape now; wiring apps/api's actual AI call sites (ai.service.ts, ai-draft.service.ts,
 * sequence-generate.service.ts) to record which version handled a given generation is a
 * separate, larger integration each of those services' own call sites need — not done here,
 * since it means threading a modelVersionId/promptVersionId through every AI generation path,
 * which risks the exact kind of broad, high-blast-radius change this pass has otherwise
 * avoided touching without a specific reason to.
 */
export const modelVersions = pgTable(
  "model_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** e.g. "claude-sonnet-5", "gpt-4o" — the model family/name, not a full version string. */
    name: text("name").notNull(),
    provider: text("provider").notNull(),
    /** e.g. "claude-sonnet-4-5-20250929" — the provider's own version identifier. */
    versionLabel: text("version_label").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    notes: text("notes"),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("model_versions_name_version_unique").on(table.name, table.versionLabel)]
);

/**
 * A named prompt (e.g. "sequence-generate.system", "ai-draft.reply-suggestion") with an
 * incrementing integer version per name, so an audit trail can say "this generation used
 * prompt X version 3 against model Y" rather than just "the AI wrote this."
 */
export const promptVersions = pgTable(
  "prompt_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    version: integer("version").notNull(),
    content: text("content").notNull(),
    modelVersionId: uuid("model_version_id").references(() => modelVersions.id, { onDelete: "set null" }),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("prompt_versions_name_version_unique").on(table.name, table.version),
    index("prompt_versions_name_active_idx").on(table.name, table.isActive),
  ]
);
