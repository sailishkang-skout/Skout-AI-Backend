import { bigint, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { apiKeys } from "./public-api.js";
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
  /** Credit category; public API charges use "data" (CRED-5). */
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
  /**
   * The public API key that spent these credits (PAPI-011, D3, CRED-5). Null for in-app use.
   * No ON DELETE action on purpose: SET NULL would UPDATE a ledger row, which the append-only
   * trigger rejects. Keys are revoked, never deleted, except when the whole workspace goes.
   */
  apiKeyId: uuid("api_key_id").references(() => apiKeys.id),
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

/**
 * Credit reservations for public API calls (PAPI-011, CRED-2). A hold is taken for the most a call
 * can cost, then committed (the actual charge goes to the ledger) or released. The balance check
 * subtracts active holds. A sweeper releases holds past `expires_at` (15 minutes).
 *
 * Constraints in SQL (migration 0165): amount > 0; status is held | committed | released;
 * one hold per (workspace, request).
 */
export const creditHolds = pgTable(
  "credit_holds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    /** The public API request id (X-Request-Id). */
    requestId: text("request_id").notNull(),
    amount: integer("amount").notNull(),
    /** held | committed | released */
    status: text("status").notNull().default("held"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** When the hold was committed or released. */
    settledAt: timestamp("settled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("credit_holds_workspace_request_uq").on(t.workspaceId, t.requestId),
    index("credit_holds_active_workspace_idx").on(t.workspaceId).where(sql`status = 'held'`),
    index("credit_holds_active_expiry_idx").on(t.expiresAt).where(sql`status = 'held'`),
  ]
);
