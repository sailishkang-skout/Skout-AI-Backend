import { and, eq, gt, sql } from "drizzle-orm";
import { CreditLedgerError, postCreditTransaction, schema, type Db } from "@skout/db";
import type { ApiPriceOperation } from "@skout/shared";
import { HttpError } from "../utils/http.js";
import { assertCreditCaps, type CreditCaps } from "./api-limits.service.js";
import { notifyBalanceAfterCharge } from "./low-balance-alert.service.js";

const { creditBalances, creditHolds } = schema;

/**
 * Public API credits: reserve → commit → release (PAPI-031, public API PRD CRED-2, CRED-3, CRED-5).
 *
 * Before a billable call, `reserve` holds the most the call can cost; the wallet balance minus every
 * active hold must cover it, else 402 insufficient_credits before any work starts. On success
 * `commit` writes the actual charge to the append-only ledger (category "data", action
 * "api.<operation>", the API key, the request id) and settles the hold; on failure, no result or a
 * timeout `release` frees it. Nothing is ever charged twice: one hold per request, and the ledger
 * entry's idempotency key is derived from the workspace and request id.
 *
 * Lock order is always wallet row, then hold row (the same wallet lock postCreditTransaction takes),
 * so concurrent reserves are serialised and reserve/commit/release can't deadlock.
 */
export const HOLD_TTL_MS = 15 * 60_000;

export interface ReservedHold {
  /** Null when nothing needed reserving (a free call). */
  holdId: string | null;
  amount: number;
  /** True when this request already had a hold (a retry), which is returned instead of a new one. */
  existing: boolean;
}

export interface CommitResult {
  charged: number;
  balance: number | null;
  /** True when the hold was already committed (a double commit charges nothing new). */
  alreadyCommitted: boolean;
}

export class InsufficientApiCreditsError extends HttpError {
  constructor(public readonly available: number, public readonly required: number) {
    super("insufficient_credits", 402, { available, required, message: "Not enough Data Credits for this request." });
    this.name = "InsufficientApiCreditsError";
  }
}

/** Locks the workspace wallet (creating it on first use) and returns its balance. */
async function lockWallet(tx: Db, workspaceId: string): Promise<number> {
  await tx.insert(creditBalances).values({ workspaceId, balance: 0 }).onConflictDoNothing();
  const [wallet] = await tx
    .select({ balance: creditBalances.balance })
    .from(creditBalances)
    .where(eq(creditBalances.workspaceId, workspaceId))
    .for("update");
  return wallet?.balance ?? 0;
}

/** Credits held by unexpired, unsettled holds. */
export async function activeHoldTotal(db: Db, workspaceId: string, now = new Date()): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${creditHolds.amount}), 0)::int` })
    .from(creditHolds)
    .where(and(eq(creditHolds.workspaceId, workspaceId), eq(creditHolds.status, "held"), gt(creditHolds.expiresAt, now)));
  return row?.total ?? 0;
}

/** Wallet balance minus active holds: what a new reservation may use. */
export async function availableCredits(db: Db, workspaceId: string, now = new Date()): Promise<{ balance: number; held: number; available: number }> {
  const [wallet] = await db.select({ balance: creditBalances.balance }).from(creditBalances).where(eq(creditBalances.workspaceId, workspaceId)).limit(1);
  const balance = wallet?.balance ?? 0;
  const held = await activeHoldTotal(db, workspaceId, now);
  return { balance, held, available: balance - held };
}

/**
 * Holds `max` credits for one request. Returns the existing hold when the request already has one.
 * Throws InsufficientApiCreditsError (402) when balance minus active holds can't cover `max`.
 */
export async function reserve(
  db: Db,
  input: {
    workspaceId: string;
    apiKeyId: string;
    requestId: string;
    max: number;
    /** Per-key and workspace credit caps (PAPI-033); checked under the wallet lock. */
    caps?: CreditCaps;
  },
  now = new Date()
): Promise<ReservedHold> {
  if (!Number.isInteger(input.max) || input.max < 0) throw new HttpError("A reservation is a whole number of credits", 500);
  if (input.max === 0) return { holdId: null, amount: 0, existing: false };
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const balance = await lockWallet(tx, input.workspaceId);
    const [prior] = await tx
      .select()
      .from(creditHolds)
      .where(and(eq(creditHolds.workspaceId, input.workspaceId), eq(creditHolds.requestId, input.requestId)))
      .limit(1);
    if (prior) return { holdId: prior.id, amount: prior.amount, existing: true };
    if (input.caps) await assertCreditCaps(tx, { workspaceId: input.workspaceId, apiKeyId: input.apiKeyId, max: input.max, caps: input.caps }, now);
    const available = balance - (await activeHoldTotal(tx, input.workspaceId, now));
    if (available < input.max) throw new InsufficientApiCreditsError(Math.max(0, available), input.max);
    const [hold] = await tx
      .insert(creditHolds)
      .values({
        workspaceId: input.workspaceId,
        apiKeyId: input.apiKeyId,
        requestId: input.requestId,
        amount: input.max,
        status: "held",
        expiresAt: new Date(now.getTime() + HOLD_TTL_MS),
        createdAt: now,
      })
      .returning();
    return { holdId: hold!.id, amount: hold!.amount, existing: false };
  });
}

async function lockHold(tx: Db, holdId: string) {
  const [peek] = await tx.select({ workspaceId: creditHolds.workspaceId }).from(creditHolds).where(eq(creditHolds.id, holdId)).limit(1);
  if (!peek) throw new HttpError("Credit hold not found", 404);
  await lockWallet(tx, peek.workspaceId); // wallet first, then the hold
  const [hold] = await tx.select().from(creditHolds).where(eq(creditHolds.id, holdId)).for("update").limit(1);
  return hold!;
}

/** The ledger idempotency key for a request's charge (CRED-5). */
export function apiChargeIdempotencyKey(workspaceId: string, requestId: string): string {
  return `api:${workspaceId}:${requestId}`;
}

/**
 * Charges `actual` (≤ the hold) for the request and settles the hold. A second commit of the same
 * hold charges nothing; committing a released hold is refused. `actual` 0 just releases it.
 */
export async function commit(db: Db, holdId: string | null, actual: number, operation: ApiPriceOperation | string): Promise<CommitResult> {
  if (!Number.isInteger(actual) || actual < 0) throw new HttpError("A charge is a whole number of credits", 500);
  if (holdId === null) {
    if (actual > 0) throw new HttpError("Can't charge a request that reserved nothing", 500);
    return { charged: 0, balance: null, alreadyCommitted: false };
  }
  const result = await commitHold(db, holdId, actual, operation);
  // CRED-8: after a real charge, check the balance against the low-balance threshold.
  if (result.charged > 0 && result.balance !== null && result.workspaceId) {
    await notifyBalanceAfterCharge(result.workspaceId, result.balance);
  }
  return { charged: result.charged, balance: result.balance, alreadyCommitted: result.alreadyCommitted };
}

async function commitHold(
  db: Db,
  holdId: string,
  actual: number,
  operation: string
): Promise<CommitResult & { workspaceId?: string }> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const hold = await lockHold(tx, holdId);
    if (hold.status === "committed") return { charged: 0, balance: null, alreadyCommitted: true };
    if (hold.status === "released") throw new HttpError("This credit hold was already released", 409);
    if (actual > hold.amount) throw new HttpError(`Charge ${actual} is more than the ${hold.amount} credits held`, 500);
    const now = new Date();
    if (actual === 0) {
      await tx.update(creditHolds).set({ status: "released", settledAt: now }).where(eq(creditHolds.id, hold.id));
      return { charged: 0, balance: null, alreadyCommitted: false };
    }
    let balance: number;
    try {
      const posted = await postCreditTransaction(tx, {
        workspaceId: hold.workspaceId,
        amount: -actual,
        kind: "consume",
        action: `api.${operation}`,
        category: "data",
        apiKeyId: hold.apiKeyId,
        referenceId: hold.requestId,
        idempotencyKey: apiChargeIdempotencyKey(hold.workspaceId, hold.requestId),
        actor: { type: "integration", id: hold.apiKeyId },
        settlesHoldId: hold.id,
      });
      balance = posted.balance;
    } catch (err) {
      if (err instanceof CreditLedgerError && err.code === "INSUFFICIENT_CREDITS") {
        // The ledger keeps held credits from being spent elsewhere, so this means the hold expired
        // (and its credits were spent) before the commit; the request is not charged.
        throw new InsufficientApiCreditsError(0, actual);
      }
      throw err;
    }
    await tx.update(creditHolds).set({ status: "committed", settledAt: now }).where(eq(creditHolds.id, hold.id));
    return { charged: actual, balance, alreadyCommitted: false, workspaceId: hold.workspaceId };
  });
}

/** Frees a hold (failure, no result, timeout). No effect on a hold that is already settled. */
export async function release(db: Db, holdId: string | null): Promise<{ released: boolean }> {
  if (holdId === null) return { released: false };
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const hold = await lockHold(tx, holdId);
    if (hold.status !== "held") return { released: false };
    await tx.update(creditHolds).set({ status: "released", settledAt: new Date() }).where(eq(creditHolds.id, hold.id));
    return { released: true };
  });
}

export interface ReleasedHold {
  id: string;
  workspaceId: string;
  apiKeyId: string;
  requestId: string;
  amount: number;
  expiresAt: Date;
}

/**
 * The hold sweeper (PAPI-032, CRED-2): releases every hold still `held` after its 15-minute expiry,
 * so credits a crashed or timed-out request reserved become spendable again. Rows another
 * transaction is committing right now are skipped (SKIP LOCKED) and settle on their own; a hold that
 * gets committed meanwhile no longer matches `status = 'held'`. Safe to run on several instances.
 */
export async function releaseExpiredHolds(db: Db, now = new Date(), batch = 500): Promise<ReleasedHold[]> {
  const rows = (await db.execute(sql`
    update ${creditHolds} set status = 'released', settled_at = ${now.toISOString()}::timestamptz
    where id in (
      select id from ${creditHolds}
      where status = 'held' and expires_at <= ${now.toISOString()}::timestamptz
      order by expires_at
      limit ${batch}
      for update skip locked
    ) and status = 'held'
    returning id, workspace_id, api_key_id, request_id, amount, expires_at
  `)) as unknown as Array<{ id: string; workspace_id: string; api_key_id: string; request_id: string; amount: number; expires_at: string | Date }>;
  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    apiKeyId: r.api_key_id,
    requestId: r.request_id,
    amount: r.amount,
    expiresAt: new Date(r.expires_at),
  }));
}
