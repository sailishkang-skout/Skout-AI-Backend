import { and, desc, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { CreditLedgerError, postCreditTransaction, schema, type Db } from "@skout/db";
import { appendCopsEvent, createCopsEvent } from "@skout/shared";
import { writeCopsAudit } from "./cops-platform.service.js";
import { EntitlementsService } from "./entitlements.service.js";

/**
 * COPS-04 credit wallet of a provisioned account (Bible p.36, 40, 48). Every change goes through the
 * append-only ledger (`postCreditTransaction`); manual grants and adjustments carry actor + reason and
 * are audited; purchases reach the wallet only from a paid payment request (PaymentSucceeded).
 */

const { copsProvisionings, creditBalances, creditTransactions, deals, paymentRequests, proposals, proposalVersions, proposalLineItems } =
  schema;

const DAY_MS = 24 * 60 * 60 * 1000;
const USAGE_DAYS = 30;
const LEDGER_PAGE = 50;

export type WalletErrorCode = "NOT_PROVISIONED" | "INSUFFICIENT_CREDITS" | "VALIDATION_FAILED";

export class WalletError extends Error {
  constructor(
    readonly code: WalletErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "WalletError";
  }

  get status(): number {
    return this.code === "NOT_PROVISIONED" ? 404 : this.code === "INSUFFICIENT_CREDITS" ? 409 : 422;
  }
}

export interface WalletContext {
  workspaceId: string;
  userId: string;
  requestId: string;
}

export interface LedgerEntryDto {
  id: string;
  seq: number | null;
  kind: string;
  amount: number;
  balance_after: number | null;
  action: string;
  reason: string | null;
  actor_type: string | null;
  actor_id: string | null;
  reference_id: string | null;
  compensates_id: string | null;
  created_at: string;
}

function toEntry(r: typeof creditTransactions.$inferSelect): LedgerEntryDto {
  return {
    id: r.id,
    seq: r.seq ?? null,
    kind: r.kind,
    amount: r.amount,
    balance_after: r.balanceAfter,
    action: r.action,
    reason: r.reason,
    actor_type: r.actorType,
    actor_id: r.actorId,
    reference_id: r.referenceId,
    compensates_id: r.compensatesId,
    created_at: r.createdAt.toISOString(),
  };
}

/** The provisioned workspace of an account in the operator workspace, or null. */
export async function findProvisionedWorkspace(db: Db, operatorWorkspaceId: string, accountId: string) {
  const [row] = await db
    .select({
      id: copsProvisionings.id,
      workspaceId: copsProvisionings.provisionedWorkspaceId,
      status: copsProvisionings.status,
      trialStartsAt: copsProvisionings.trialStartsAt,
      trialEndsAt: copsProvisionings.trialEndsAt,
    })
    .from(copsProvisionings)
    .where(
      and(
        eq(copsProvisionings.workspaceId, operatorWorkspaceId),
        eq(copsProvisionings.accountId, accountId),
        isNotNull(copsProvisionings.provisionedWorkspaceId)
      )
    )
    .orderBy(desc(copsProvisionings.createdAt))
    .limit(1);
  return row?.workspaceId ? { ...row, workspaceId: row.workspaceId } : null;
}

async function requireWallet(db: Db, operatorWorkspaceId: string, accountId: string) {
  const found = await findProvisionedWorkspace(db, operatorWorkspaceId, accountId);
  if (!found || found.status !== "succeeded") {
    throw new WalletError("NOT_PROVISIONED", "This account has no provisioned workspace yet");
  }
  return found;
}

/** GET /accounts/:id/credits: balance, a ledger page (newest first, cursor = seq) and 30-day usage. */
export async function getWallet(db: Db, operatorWorkspaceId: string, accountId: string, opts: { cursor?: string; limit?: number } = {}) {
  const wallet = await requireWallet(db, operatorWorkspaceId, accountId);
  const limit = Math.min(Math.max(opts.limit ?? LEDGER_PAGE, 1), 200);
  const before = opts.cursor && /^\d+$/.test(opts.cursor) ? Number(opts.cursor) : null;
  const [balance] = await db
    .select({ balance: creditBalances.balance })
    .from(creditBalances)
    .where(eq(creditBalances.workspaceId, wallet.workspaceId))
    .limit(1);
  const rows = await db
    .select()
    .from(creditTransactions)
    .where(and(eq(creditTransactions.workspaceId, wallet.workspaceId), before !== null ? lt(creditTransactions.seq, before) : undefined))
    .orderBy(desc(creditTransactions.seq))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const since = new Date(Date.now() - USAGE_DAYS * DAY_MS);
  const usage = (await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${creditTransactions.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
      consumed: sql<number>`(-sum(${creditTransactions.amount}))::int`,
    })
    .from(creditTransactions)
    .where(
      and(
        eq(creditTransactions.workspaceId, wallet.workspaceId),
        eq(creditTransactions.kind, "consume"),
        gte(creditTransactions.createdAt, since)
      )
    )
    .groupBy(sql`1`)
    .orderBy(sql`1`)) as Array<{ day: string; consumed: number }>;
  return {
    workspace_id: wallet.workspaceId,
    provisioning_id: wallet.id,
    balance: balance?.balance ?? 0,
    trial_starts_at: wallet.trialStartsAt?.toISOString() ?? null,
    trial_ends_at: wallet.trialEndsAt?.toISOString() ?? null,
    ledger: page.map(toEntry),
    next_cursor: rows.length > limit && page.length ? String(page[page.length - 1]!.seq) : null,
    usage,
  };
}

function ledgerError(error: unknown): never {
  if (error instanceof CreditLedgerError) {
    if (error.code === "INSUFFICIENT_CREDITS") throw new WalletError("INSUFFICIENT_CREDITS", "The balance would go below zero", error.details);
    throw new WalletError("VALIDATION_FAILED", error.message, {
      fields: [{ path: error.message.includes("compensates_id") ? "compensates_id" : "amount", code: "invalid", message: error.message }],
    });
  }
  throw error;
}

/**
 * Complimentary grant or manual adjustment (credits:adjust). The request's Idempotency-Key becomes the
 * ledger key, so a duplicate submit is applied once even past the HTTP idempotency window.
 */
export async function postManualCredit(
  db: Db,
  ctx: WalletContext,
  accountId: string,
  input: { kind: "grant" | "adjustment"; amount: number; reason: string; compensatesId?: string | null; requestKey: string }
) {
  const wallet = await requireWallet(db, ctx.workspaceId, accountId);
  try {
    return await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const actor = { type: "user" as const, id: ctx.userId };
      const action = input.kind === "grant" ? "complimentary_grant" : "manual_adjustment";
      const posted = await postCreditTransaction(tx, {
        workspaceId: wallet.workspaceId,
        amount: input.amount,
        kind: input.kind,
        action,
        reason: input.reason,
        actor,
        idempotencyKey: `cops-${input.kind}:${input.requestKey}`,
        correlationId: ctx.requestId,
        compensatesId: input.compensatesId ?? null,
      });
      if (!posted.replayed) {
        await writeCopsAudit(tx, {
          tenantId: ctx.workspaceId,
          actor,
          entityType: "credit_wallet",
          entityId: wallet.workspaceId,
          action: input.kind === "grant" ? "credits.granted" : "credits.adjusted",
          before: { balance: posted.balance - input.amount },
          after: { balance: posted.balance, amount: input.amount, transaction_id: posted.transaction.id, compensates_id: input.compensatesId ?? null },
          reason: input.reason,
          override: input.kind === "adjustment",
          correlationId: ctx.requestId,
          sourceChannel: "api",
        });
        if (input.kind === "grant") {
          await appendCopsEvent(
            tx as never,
            createCopsEvent({
              eventType: "CreditsGranted",
              tenantId: ctx.workspaceId,
              aggregateType: "account",
              aggregateId: accountId,
              actor,
              correlationId: ctx.requestId,
              payload: { wallet_id: wallet.workspaceId, amount: input.amount, reason: input.reason, account_id: accountId },
            })
          );
        }
      }
      return { entry: toEntry(posted.transaction), balance: posted.balance, replayed: posted.replayed };
    });
  } catch (error) {
    ledgerError(error);
  }
}

/** POST /accounts/:id/trial/extend: moves the trial end forward; reason required; audited. */
export async function extendTrial(db: Db, ctx: WalletContext, accountId: string, input: { days: number; reason: string }) {
  const wallet = await requireWallet(db, ctx.workspaceId, accountId);
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const [row] = await tx
      .select({ trialStartsAt: copsProvisionings.trialStartsAt, trialEndsAt: copsProvisionings.trialEndsAt })
      .from(copsProvisionings)
      .where(eq(copsProvisionings.id, wallet.id))
      .for("update")
      .limit(1);
    const previous = row?.trialEndsAt ?? new Date();
    // An expired trial is extended from today, not from its past end date.
    const base = previous.getTime() < Date.now() ? Date.now() : previous.getTime();
    const endsAt = new Date(base + input.days * DAY_MS);
    const startsAt = row?.trialStartsAt ?? new Date();
    await tx.update(copsProvisionings).set({ trialEndsAt: endsAt, updatedAt: new Date() }).where(eq(copsProvisionings.id, wallet.id));
    await new EntitlementsService(tx).set(
      wallet.workspaceId,
      "trial",
      { starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString() },
      "cops_trial_extension"
    );
    await writeCopsAudit(tx, {
      tenantId: ctx.workspaceId,
      actor: { type: "user", id: ctx.userId },
      entityType: "account",
      entityId: accountId,
      action: "trial.extended",
      before: { trial_ends_at: previous.toISOString() },
      after: { trial_ends_at: endsAt.toISOString(), days: input.days },
      reason: input.reason,
      correlationId: ctx.requestId,
      sourceChannel: "api",
    });
    return { trial_starts_at: startsAt.toISOString(), trial_ends_at: endsAt.toISOString() };
  });
}

/**
 * Bible p.36: purchased credits reach the wallet only after a confirmed payment. For every paid
 * payment request of the account whose proposal has `credits` lines, post one `purchase` (ledger key
 * = payment request id, so the webhook and the provisioning step can both call this safely). Called
 * from the payment webhook (PaymentSucceeded) and from the provisioning wallet step, so a payment
 * made before the workspace existed is applied when it is created. Returns credits newly applied.
 */
export async function applyPaidCreditPurchases(
  tx: Db,
  input: { operatorWorkspaceId: string; accountId: string; walletWorkspaceId?: string; requestId: string }
): Promise<number> {
  const walletWorkspaceId =
    input.walletWorkspaceId ?? (await findProvisionedWorkspace(tx, input.operatorWorkspaceId, input.accountId))?.workspaceId;
  if (!walletWorkspaceId) return 0;
  const paid = (await tx
    .select({
      paymentRequestId: paymentRequests.id,
      credits: sql<number>`coalesce(sum(${proposalLineItems.quantity}), 0)::int`,
    })
    .from(paymentRequests)
    .innerJoin(deals, eq(deals.id, paymentRequests.opportunityId))
    .innerJoin(proposals, eq(proposals.id, paymentRequests.proposalId))
    .innerJoin(proposalVersions, and(eq(proposalVersions.proposalId, proposals.id), eq(proposalVersions.version, proposals.currentVersion)))
    .innerJoin(proposalLineItems, and(eq(proposalLineItems.versionId, proposalVersions.id), eq(proposalLineItems.kind, "credits")))
    .where(
      and(
        eq(paymentRequests.workspaceId, input.operatorWorkspaceId),
        eq(paymentRequests.status, "paid"),
        eq(deals.companyId, input.accountId)
      )
    )
    .groupBy(paymentRequests.id)) as Array<{ paymentRequestId: string; credits: number }>;

  let applied = 0;
  for (const p of paid) {
    if (p.credits <= 0) continue;
    const actor = { type: "integration" as const, id: "payment_request" };
    const reason = `Credits purchased (payment request ${p.paymentRequestId})`;
    const posted = await postCreditTransaction(tx, {
      workspaceId: walletWorkspaceId,
      amount: p.credits,
      kind: "purchase",
      action: "cops_payment",
      referenceId: p.paymentRequestId,
      reason,
      actor,
      idempotencyKey: `cops-payment:${p.paymentRequestId}`,
      correlationId: input.requestId,
    });
    if (posted.replayed) continue;
    applied += p.credits;
    await writeCopsAudit(tx, {
      tenantId: input.operatorWorkspaceId,
      actor,
      entityType: "credit_wallet",
      entityId: walletWorkspaceId,
      action: "credits.purchased",
      after: { amount: p.credits, balance: posted.balance, payment_request_id: p.paymentRequestId, transaction_id: posted.transaction.id },
      correlationId: input.requestId,
      sourceChannel: "webhook",
    });
    await appendCopsEvent(
      tx as never,
      createCopsEvent({
        eventType: "CreditsGranted",
        tenantId: input.operatorWorkspaceId,
        aggregateType: "account",
        aggregateId: input.accountId,
        actor,
        correlationId: input.requestId,
        payload: { wallet_id: walletWorkspaceId, amount: p.credits, reason, account_id: input.accountId },
      })
    );
  }
  return applied;
}
