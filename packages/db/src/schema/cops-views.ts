import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { users } from "./users.js";

/**
 * COPS-02 saved views: a named set of list filters for one object type. Private by default;
 * `shared` makes it visible to everyone in the workspace. Only the owner can change or delete it.
 */
export const copsSavedViews = pgTable(
  "cops_saved_views",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    objectType: text("object_type").notNull(),
    filters: jsonb("filters").$type<Record<string, unknown>>().notNull().default({}),
    sort: text("sort"),
    shared: boolean("shared").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index("cops_saved_views_workspace_idx").on(t.workspaceId, t.objectType),
  })
);
