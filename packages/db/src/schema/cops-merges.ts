import { jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { users } from "./users.js";

/**
 * History of account merges. The duplicate's id is kept here so an old reference can still be
 * traced to the survivor. A duplicate can be merged only once per workspace.
 */
export const copsAccountMerges = pgTable(
  "cops_account_merges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    survivorId: uuid("survivor_id").notNull(),
    duplicateId: uuid("duplicate_id").notNull(),
    duplicateName: text("duplicate_name").notNull(),
    reason: text("reason").notNull(),
    conflicts: jsonb("conflicts").$type<Array<{ field: string; survivor_value: unknown; duplicate_value: unknown }>>().notNull().default([]),
    mergedBy: uuid("merged_by").references(() => users.id, { onDelete: "set null" }),
    mergedAt: timestamp("merged_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqueDuplicate: unique("cops_account_merges_duplicate_unique").on(t.workspaceId, t.duplicateId),
  })
);
