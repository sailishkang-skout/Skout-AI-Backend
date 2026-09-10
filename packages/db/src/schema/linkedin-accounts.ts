import { boolean, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

/** Unipile messaging accounts (LinkedIn + WhatsApp) for server-side outreach. */
export const linkedinAccounts = pgTable(
  "linkedin_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Unipile account id used in API calls */
    unipileAccountId: text("unipile_account_id").notNull(),
    /** linkedin | whatsapp */
    channel: text("channel").notNull().default("linkedin"),
    displayName: text("display_name"),
    linkedinUrl: text("linkedin_url"),
    /** E.164 / display phone for WhatsApp accounts */
    phone: text("phone"),
    status: text("status").notNull().default("active"),
    dailySendLimit: integer("daily_send_limit").notNull().default(40),
    sentCount: integer("sent_count").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    lastError: text("last_error"),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.workspaceId, table.unipileAccountId)]
);
