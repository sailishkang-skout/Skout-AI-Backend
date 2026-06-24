import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

export const paymentOrders = pgTable("payment_orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  provider: text("provider").notNull().default("razorpay"),
  providerOrderId: text("provider_order_id").notNull(),
  packId: text("pack_id").notNull(),
  amountPaise: integer("amount_paise").notNull(),
  credits: integer("credits").notNull(),
  status: text("status").notNull().default("created"),
  razorpayPaymentId: text("razorpay_payment_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  paidAt: timestamp("paid_at", { withTimezone: true }),
});
