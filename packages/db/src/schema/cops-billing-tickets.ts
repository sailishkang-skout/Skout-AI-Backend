import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { companies } from "./crm.js";
import { users } from "./users.js";
import { paymentRequests, subscriptions } from "./cops-commercial.js";

/**
 * A refund or cancellation the customer asked for. Customer Success raises it, Finance takes it and
 * either does it (refund the payment / cancel the subscription) or declines it with a note.
 */
export const copsBillingTickets = pgTable(
  "cops_billing_tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** refund | cancel */
    kind: text("kind").notNull(),
    /** open | in_progress | done | declined */
    status: text("status").notNull().default("open"),
    /** The paid payment to refund (kind = refund). */
    paymentRequestId: uuid("payment_request_id").references(() => paymentRequests.id, { onDelete: "set null" }),
    /** The subscription to cancel (kind = cancel). */
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, { onDelete: "set null" }),
    /** What the customer asked and why, in the raiser's words. */
    reason: text("reason").notNull(),
    raisedBy: uuid("raised_by").references(() => users.id, { onDelete: "set null" }),
    assigneeId: uuid("assignee_id").references(() => users.id, { onDelete: "set null" }),
    resolutionNote: text("resolution_note"),
    resolvedBy: uuid("resolved_by").references(() => users.id, { onDelete: "set null" }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("cops_billing_tickets_queue_idx").on(table.workspaceId, table.status, table.createdAt),
    index("cops_billing_tickets_account_idx").on(table.workspaceId, table.accountId),
  ]
);
