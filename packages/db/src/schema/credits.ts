import { bigint, integer, jsonb, pgTable, text, timestamp, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

export const creditBalances = pgTable("credit_balances", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  balance: integer("balance").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Append-only credit ledger (COPS-04). A database trigger rejects UPDATE and DELETE (DELETE is
 * allowed only once the workspace itself is gone). Write rows only through `postCreditTransaction`
 * in `credit-ledger.ts`; it keeps `credit_balances` in step under a row lock.
 */
export const creditTransactions = pgTable("credit_transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Insertion order; ties in created_at are common inside one transaction. */
  seq: bigint("seq", { mode: "number" }).generatedByDefaultAsIdentity(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  amount: integer("amount").notNull(),
  /** grant | purchase | consume | refund | expire | adjustment */
  kind: text("kind").notNull(),
  /** Free-form source label kept from before COPS-04, e.g. search, razorpay_purchase, admin_topup. */
  action: text("action").notNull(),
  /** Reserved for credit categories (open question for Product). */
  category: text("category"),
  referenceId: text("reference_id"),
  balanceAfter: integer("balance_after"),
  reason: text("reason"),
  actorType: text("actor_type"),
  actorId: text("actor_id"),
  /** Unique per workspace; a repeated key returns the original row. */
  idempotencyKey: text("idempotency_key"),
  correlationId: text("correlation_id"),
  /** The row this entry corrects; corrections never edit the original. */
  compensatesId: uuid("compensates_id").references((): AnyPgColumn => creditTransactions.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Platform-wide reconciliation results (operations data, not tenant data). */
export const creditReconciliationRuns = pgTable("credit_reconciliation_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  walletsChecked: integer("wallets_checked").notNull().default(0),
  mismatchCount: integer("mismatch_count").notNull().default(0),
  mismatches: jsonb("mismatches").notNull().default([]),
  triggeredBy: text("triggered_by").notNull().default("schedule"),
});
