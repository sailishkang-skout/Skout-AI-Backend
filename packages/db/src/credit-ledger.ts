import { and, desc, eq, gt, ne, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { creditBalances, creditHolds, creditReconciliationRuns, creditTransactions } from "./schema/credits.js";

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
  /** Credit category; public API charges use "data" (CRED-5). */
  category?: string | null;
  /** Public API key that spent the credits (PAPI-011). Null for in-app use. */
  apiKeyId?: string | null;
  reason?: string | null;
  actor?: { type: "user" | "system" | "integration"; id: string | null };
  idempotencyKey?: string | null;
  correlationId?: string | null;
  compensatesId?: string | null;
  /** Manual adjustments and consumes refuse a negative balance unless this is set. */
  allowNegativeBalance?: boolean;
  /**
   * The public API credit hold this consume settles (PAPI-031). A consume may not spend credits held
   * for in-flight API requests (the shared wallet's balance check subtracts active holds); the hold
   * being settled is the one exception, because those are its own credits.
   */
  settlesHoldId?: string | null;
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
    if (input.kind === "consume" && !input.allowNegativeBalance) {
      // Credits held for in-flight public API requests are not spendable (PAPI-031, shared wallet).
      const [held] = await tx
        .select({ total: sql<number>`coalesce(sum(${creditHolds.amount}), 0)::int` })
        .from(creditHolds)
        .where(
          and(
            eq(creditHolds.workspaceId, input.workspaceId),
            eq(creditHolds.status, "held"),
            gt(creditHolds.expiresAt, new Date()),
            ...(input.settlesHoldId ? [ne(creditHolds.id, input.settlesHoldId)] : [])
          )
        );
      const heldTotal = held?.total ?? 0;
      if (next - heldTotal < 0) {
        throw new CreditLedgerError("INSUFFICIENT_CREDITS", "not enough credits", { balance, held: heldTotal, requested: -input.amount });
      }
    }

    const [transaction] = await tx
      .insert(creditTransactions)
      .values({
        workspaceId: input.workspaceId,
        amount: input.amount,
        kind: input.kind,
        action: input.action,
        referenceId: input.referenceId ?? null,
        category: input.category ?? null,
        apiKeyId: input.apiKeyId ?? null,
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
/** A public API credit inconsistency (PAPI-035): holds vs. ledger charges vs. API keys. */
export interface ApiCreditMismatch {
  workspace_id: string;
  problem:
    | "hold_committed_without_charge"
    | "charge_exceeds_hold"
    | "charge_without_hold"
    | "charge_key_differs_from_hold"
    | "key_from_other_workspace"
    | "api_key_total_differs"
    | "stale_hold";
  hold_id?: string | null;
  transaction_id?: string | null;
  api_key_id?: string | null;
  request_id?: string | null;
  expected?: number | null;
  actual?: number | null;
}

/** A hold still "held" this long after expiring means the sweeper (PAPI-032) isn't running. */
export const STALE_HOLD_GRACE_MS = 60 * 60_000;

/**
 * PAPI-035: checks public API charges against their holds and their API keys. Every committed hold
 * must have its one ledger charge (idempotency key api:<workspace>:<request>), never larger than the
 * hold and on the same key; every API charge must belong to a committed hold; keys must belong to the
 * workspace; each key's ledger total must equal what its committed holds charged; and no hold may
 * stay "held" long after it expired. Never changes data.
 */
export async function reconcileApiCredits(db: Db, opts: { workspaceId?: string; now?: Date } = {}): Promise<ApiCreditMismatch[]> {
  const now = opts.now ?? new Date();
  const scope = (alias: "h" | "t") => (opts.workspaceId ? sql`and ${sql.raw(alias)}.workspace_id = ${opts.workspaceId}` : sql``);
  type Row = Record<string, unknown>;
  const q = async (query: ReturnType<typeof sql>) => (await db.execute(query)) as unknown as Row[];
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
  const out: ApiCreditMismatch[] = [];

  // Committed holds and their charge, joined by the ledger idempotency key.
  const holds = await q(sql`
    select h.id as hold_id, h.workspace_id, h.api_key_id as hold_key, h.request_id, h.amount,
           t.id as transaction_id, -t.amount as charged, t.api_key_id as charge_key
    from credit_holds h
    left join credit_transactions t
      on t.workspace_id = h.workspace_id and t.idempotency_key = 'api:' || h.workspace_id || ':' || h.request_id
    where h.status = 'committed' ${scope("h")}
  `);
  for (const r of holds) {
    const base = { workspace_id: String(r.workspace_id), hold_id: str(r.hold_id), request_id: str(r.request_id), api_key_id: str(r.hold_key) };
    if (!r.transaction_id) {
      out.push({ ...base, problem: "hold_committed_without_charge", expected: num(r.amount), actual: 0 });
      continue;
    }
    if (Number(r.charged) > Number(r.amount)) {
      out.push({ ...base, transaction_id: str(r.transaction_id), problem: "charge_exceeds_hold", expected: num(r.amount), actual: num(r.charged) });
    }
    if (str(r.charge_key) !== str(r.hold_key)) {
      out.push({ ...base, transaction_id: str(r.transaction_id), problem: "charge_key_differs_from_hold" });
    }
  }

  // API charges with no committed hold behind them.
  const orphans = await q(sql`
    select t.id, t.workspace_id, t.api_key_id, t.reference_id, -t.amount as charged
    from credit_transactions t
    where t.kind = 'consume' and t.idempotency_key like 'api:%' ${scope("t")}
      and not exists (
        select 1 from credit_holds h
        where h.workspace_id = t.workspace_id and h.status = 'committed'
          and t.idempotency_key = 'api:' || h.workspace_id || ':' || h.request_id
      )
  `);
  for (const r of orphans) {
    out.push({ workspace_id: String(r.workspace_id), problem: "charge_without_hold", transaction_id: str(r.id), api_key_id: str(r.api_key_id), request_id: str(r.reference_id), actual: num(r.charged) });
  }

  // Keys used outside their own workspace.
  const foreign = await q(sql`
    select t.workspace_id, t.id as transaction_id, null::uuid as hold_id, t.api_key_id
    from credit_transactions t join api_keys k on k.id = t.api_key_id
    where k.workspace_id <> t.workspace_id ${scope("t")}
    union all
    select h.workspace_id, null::uuid, h.id, h.api_key_id
    from credit_holds h join api_keys k on k.id = h.api_key_id
    where k.workspace_id <> h.workspace_id ${scope("h")}
  `);
  for (const r of foreign) {
    out.push({ workspace_id: String(r.workspace_id), problem: "key_from_other_workspace", transaction_id: str(r.transaction_id), hold_id: str(r.hold_id), api_key_id: str(r.api_key_id) });
  }

  // Per-key totals: everything the ledger charged a key vs. what that key's committed holds charged.
  const totals = await q(sql`
    with ledger as (
      select t.workspace_id, t.api_key_id, coalesce(-sum(t.amount), 0)::int as total
      from credit_transactions t
      where t.api_key_id is not null and t.kind = 'consume' ${scope("t")}
      group by t.workspace_id, t.api_key_id
    ), via_holds as (
      select h.workspace_id, h.api_key_id, coalesce(-sum(t.amount), 0)::int as total
      from credit_holds h
      join credit_transactions t on t.workspace_id = h.workspace_id and t.idempotency_key = 'api:' || h.workspace_id || ':' || h.request_id
      where h.status = 'committed' ${scope("h")}
      group by h.workspace_id, h.api_key_id
    )
    select coalesce(l.workspace_id, v.workspace_id) as workspace_id, coalesce(l.api_key_id, v.api_key_id) as api_key_id,
           coalesce(l.total, 0) as ledger_total, coalesce(v.total, 0) as hold_total
    from ledger l full join via_holds v on v.workspace_id = l.workspace_id and v.api_key_id = l.api_key_id
    where coalesce(l.total, 0) <> coalesce(v.total, 0)
  `);
  for (const r of totals) {
    out.push({ workspace_id: String(r.workspace_id), problem: "api_key_total_differs", api_key_id: str(r.api_key_id), expected: num(r.hold_total), actual: num(r.ledger_total) });
  }

  // Holds the sweeper should have released long ago.
  const staleBefore = new Date(now.getTime() - STALE_HOLD_GRACE_MS).toISOString();
  const stale = await q(sql`
    select h.id, h.workspace_id, h.api_key_id, h.request_id, h.amount from credit_holds h
    where h.status = 'held' and h.expires_at < ${staleBefore}::timestamptz ${scope("h")}
  `);
  for (const r of stale) {
    out.push({ workspace_id: String(r.workspace_id), problem: "stale_hold", hold_id: str(r.id), api_key_id: str(r.api_key_id), request_id: str(r.request_id), actual: num(r.amount) });
  }
  return out;
}

export async function reconcileCreditLedger(
  db: Db,
  opts: { workspaceId?: string; record?: boolean; triggeredBy?: string; now?: Date } = {}
): Promise<{ runId: string | null; walletsChecked: number; mismatches: CreditMismatch[]; apiMismatches: ApiCreditMismatch[] }> {
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

  const apiMismatches = await reconcileApiCredits(db, { workspaceId: opts.workspaceId, now: opts.now });

  let runId: string | null = null;
  if (opts.record) {
    const [run] = await db
      .insert(creditReconciliationRuns)
      .values({
        finishedAt: new Date(),
        walletsChecked: rows.length,
        mismatchCount: mismatches.length + apiMismatches.length,
        mismatches: [...mismatches, ...apiMismatches],
        triggeredBy: opts.triggeredBy ?? "schedule",
      })
      .returning({ id: creditReconciliationRuns.id });
    runId = run?.id ?? null;
  }
  return { runId, walletsChecked: rows.length, mismatches, apiMismatches };
}

export async function latestReconciliationRuns(db: Db, limit = 10) {
  return db.select().from(creditReconciliationRuns).orderBy(desc(creditReconciliationRuns.startedAt)).limit(limit);
}
