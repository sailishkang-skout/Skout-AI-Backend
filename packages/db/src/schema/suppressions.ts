import { pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

/** Emails that must never be sent to again (unsubscribed / bounced / manual). */
export const suppressions = pgTable(
  "suppressions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    reason: text("reason").notNull().default("unsubscribed"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.workspaceId, table.email)]
);
