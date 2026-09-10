import { integer, jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

export const workspaceIcp = pgTable("workspace_icp", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  config: jsonb("config").notNull().default({}),
  version: integer("version").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
