import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { creditBalances, creditReconciliationRuns, creditTransactions } from "./schema/credits.js";

/**
 * COPS-04 credit ledger: the single path that changes a wallet balance (Bible p.36, 40).
 *
 * Every write locks the wallet row, so concurrent writes are serialised and none is lost; repeats
 * of an idempotency key return the original row; the balance never goes below zero unless the
 * caller says so explicitly. Rows are append-only (database trigger); corrections are new rows
 * that point at the row they correct.
 */

export const CREDIT_KINDS = ["grant", "purchase", "consume", "refund", "expire", "adjustment"] as const;
export type CreditKind = (typeof CREDIT_KINDS)[number];

/** Sign each kind must have; adjustments may go either way. */
const SIGN: Record<CreditKind, 1 | -1 | 0> = { grant: 1, purchase: 1, refund: 1, consume: -1, expire: -1, adjustment: 0 };

export type CreditLedgerErrorCode = "INSUFFICIENT_CREDITS" | "INVALID_CREDIT_TRANSACTION";

export class CreditLedgerError extends Error {
  constructor(
    readonly code: CreditLedgerErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "CreditLedgerError";
  }
}

export interface PostCreditInput {
  workspaceId: string;
  /** Signed amount: positive adds credits, negative removes them. */
  amount: number;
  kind: CreditKind;
  /** Source label, e.g. search, razorpay_purchase, provision, admin_topup. */
  action: string;
  referenceId?: string | null;
  reason?: string | null;
  actor?: { type: "user" | "system" | "integration"; id: string | null };
  idempotencyKey?: string | null;
  correlationId?: string | null;
  compensatesId?: string | null;
  /** Manual adjustments and consumes refuse a negative balance unless this is set. */
  allowNegativeBalance?: boolean;
}

export type CreditTransactionRow = typeof creditTransactions.$inferSelect;

export interface PostCreditResult {
  transaction: CreditTransactionRow;
  balance: number;
  /** True when the idempotency key had already been used; nothing new was written. */
  replayed: boolean;
}

/** Whether a manual entry needs a reason (Bible p.40: every manual adjustment needs actor + reason). */
function needsReason(input: PostCreditInput) {
  return input.kind === "adjustment" || (input.kind === "grant" && input.actor?.type === "user");
}

export async function postCreditTransaction(db: Db, input: PostCreditInput): Promise<PostCreditResult> {
  if (!Number.isInteger(input.amount) || input.amount === 0) {
    throw new CreditLedgerError("INVALID_CREDIT_TRANSACTION", "amount must be a non-zero integer", { amount: input.amount });
  }
  const sign = SIGN[input.kind];
  if (sign === undefined) {
    throw new CreditLedgerError("INVALID_CREDIT_TRANSACTION", `unknown kind ${String(input.kind)}`);
  }
  if (sign !== 0 && Math.sign(input.amount) !== sign) {
    throw new CreditLedgerError("INVALID_CREDIT_TRANSACTION", `${input.kind} must be ${sign > 0 ? "positive" : "negative"}`, {
      kind: input.kind,
      amount: input.amount,
    });
  }
  if (needsReason(input) && !input.reason?.trim()) {
    throw new CreditLedgerError("INVALID_CREDIT_TRANSACTION", "a reason is required for manual credit changes", { kind: input.kind });
  }

  return db.transaction(async (tx) => {
    // Lock the wallet (creating it on first use). Everything below runs one writer at a time.
    await tx.insert(creditBalances).values({ workspaceId: input.workspaceId, balance: 0 }).onConflictDoNothing();
    const [wallet] = await tx
      .select({ balance: creditBalances.balance })
      .from(creditBalances)
      .where(eq(creditBalances.workspaceId, input.workspaceId))
      .for("update");
    const balance = wallet?.balance ?? 0;

    if (input.idempotencyKey) {
      const [existing] = await tx
        .select()
        .from(creditTransactions)
        .where(and(eq(creditTransactions.workspaceId, input.workspaceId), eq(creditTransactions.idempotencyKey, input.idempotencyKey)))
        .limit(1);
      if (existing) return { transaction: existing, balance, replayed: true };
    }

    if (input.compensatesId) {
      const [original] = await tx
        .select({ id: creditTransactions.id })
        .from(creditTransactions)
        .where(and(eq(creditTransactions.id, input.compensatesId), eq(creditTransactions.workspaceId, input.workspaceId)))
        .limit(1);
      if (!original) {
        throw new CreditLedgerError("INVALID_CREDIT_TRANSACTION", "compensates_id is not a transaction of this wallet", {
          compensates_id: input.compensatesId,
        });
      }
    }

    const next = balance + input.amount;
    if (next < 0 && !input.allowNegativeBalance) {
      throw new CreditLedgerError("INSUFFICIENT_CREDITS", "not enough credits", { balance, requested: -input.amount });
    }

    const [transaction] = await tx
      .insert(creditTransactions)
      .values({
        workspaceId: input.workspaceId,
        amount: input.amount,
        kind: input.kind,
        action: input.action,
        referenceId: input.referenceId ?? null,
        balanceAfter: next,
        reason: input.reason?.trim() || null,
        actorType: input.actor?.type ?? "system",
        actorId: input.actor?.id ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        correlationId: input.correlationId ?? null,
        compensatesId: input.compensatesId ?? null,
      })
      .returning();
    await tx
      .update(creditBalances)
      .set({ balance: next, updatedAt: new Date() })
      .where(eq(creditBalances.workspaceId, input.workspaceId));
    return { transaction: transaction!, balance: next, replayed: false };
  }) as Promise<PostCreditResult>;
}

export interface CreditMismatch {
  workspace_id: string;
  balance: number | null;
  ledger_sum: number;
  last_balance_after: number | null;
  problem: "balance_differs_from_ledger" | "balance_differs_from_last_entry" | "ledger_without_wallet";
}

/**
 * Compares every wallet with its ledger. Never changes data: a mismatch is a finding for a person
 * to correct with a compensating adjustment. Records the run when `record` is set.
 */
export async function reconcileCreditLedger(
  db: Db,
  opts: { workspaceId?: string; record?: boolean; triggeredBy?: string } = {}
): Promise<{ runId: string | null; walletsChecked: number; mismatches: CreditMismatch[] }> {
  const scope = opts.workspaceId ? sql`where w.workspace_id = ${opts.workspaceId}` : sql``;
  const rows = (await db.execute(sql`
    with wallet_ids as (
      select workspace_id from credit_balances
      union
      select distinct workspace_id from credit_transactions
    ), w as (select workspace_id from wallet_ids)
    select w.workspace_id,
           b.balance,
           coalesce((select sum(t.amount) from credit_transactions t where t.workspace_id = w.workspace_id), 0)::integer as ledger_sum,
           (select t.balance_after from credit_transactions t where t.workspace_id = w.workspace_id order by t.seq desc limit 1) as last_balance_after
    from w left join credit_balances b on b.workspace_id = w.workspace_id
    ${scope}
  `)) as unknown as Array<{ workspace_id: string; balance: number | null; ledger_sum: number; last_balance_after: number | null }>;

  const mismatches: CreditMismatch[] = [];
  for (const r of rows) {
    const base = { workspace_id: r.workspace_id, balance: r.balance, ledger_sum: Number(r.ledger_sum), last_balance_after: r.last_balance_after };
    if (r.balance === null) mismatches.push({ ...base, problem: "ledger_without_wallet" });
    else if (r.balance !== Number(r.ledger_sum)) mismatches.push({ ...base, problem: "balance_differs_from_ledger" });
    else if (r.last_balance_after !== null && r.last_balance_after !== r.balance) {
      mismatches.push({ ...base, problem: "balance_differs_from_last_entry" });
    }
  }

  let runId: string | null = null;
  if (opts.record) {
    const [run] = await db
      .insert(creditReconciliationRuns)
      .values({
        finishedAt: new Date(),
        walletsChecked: rows.length,
        mismatchCount: mismatches.length,
        mismatches,
        triggeredBy: opts.triggeredBy ?? "schedule",
      })
      .returning({ id: creditReconciliationRuns.id });
    runId = run?.id ?? null;
  }
  return { runId, walletsChecked: rows.length, mismatches };
}

export async function latestReconciliationRuns(db: Db, limit = 10) {
  return db.select().from(creditReconciliationRuns).orderBy(desc(creditReconciliationRuns.startedAt)).limit(limit);
}
