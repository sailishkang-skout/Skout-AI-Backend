import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { createDb, type Db } from "./client.js";
import { CreditLedgerError, postCreditTransaction, reconcileCreditLedger } from "./credit-ledger.js";

/**
 * COPS-04 ledger acceptance against a real Postgres (COPS_TEST_DATABASE_URL with migration 0112):
 * no UPDATE/DELETE path on ledger rows; duplicate adjustment is idempotent; concurrent writes
 * are not lost; reconciliation detects corruption.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("COPS-04 credit ledger", () => {
  let db: Db;
  let sql: ReturnType<typeof postgres>;
  let close: () => Promise<void>;
  const workspaces: string[] = [];

  async function newWorkspace() {
    const id = randomUUID();
    await sql`insert into workspaces (id, name, slug) values (${id}, 'Ledger test', ${"ledger-" + id})`;
    workspaces.push(id);
    return id;
  }

  beforeAll(() => {
    const created = createDb(url as string);
    db = created.db;
    close = () => created.sql.end();
    sql = postgres(url as string, { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    // Deleting the workspace is the only way ledger rows go away (cascade).
    for (const id of workspaces) await sql`delete from workspaces where id = ${id}`;
    await sql.end();
    await close();
  });

  it("posts entries with balance_after and keeps the wallet in step", async () => {
    const ws = await newWorkspace();
    await postCreditTransaction(db, { workspaceId: ws, amount: 500, kind: "grant", action: "provision" });
    const spent = await postCreditTransaction(db, { workspaceId: ws, amount: -120, kind: "consume", action: "search" });
    expect(spent.balance).toBe(380);
    expect(spent.transaction.balanceAfter).toBe(380);
    const [wallet] = await sql`select balance from credit_balances where workspace_id = ${ws}`;
    expect(wallet!.balance).toBe(380);
  });

  it("rejects UPDATE and DELETE of ledger rows in the database", async () => {
    const ws = await newWorkspace();
    const { transaction } = await postCreditTransaction(db, { workspaceId: ws, amount: 50, kind: "grant", action: "provision" });
    await expect(sql`update credit_transactions set amount = 5000 where id = ${transaction.id}`).rejects.toThrow(/append-only/);
    await expect(sql`delete from credit_transactions where id = ${transaction.id}`).rejects.toThrow(/append-only/);
    const [row] = await sql`select amount from credit_transactions where id = ${transaction.id}`;
    expect(row!.amount).toBe(50);
  });

  it("a duplicate adjustment (same idempotency key) is applied once", async () => {
    const ws = await newWorkspace();
    await postCreditTransaction(db, { workspaceId: ws, amount: 100, kind: "grant", action: "provision" });
    const input = {
      workspaceId: ws,
      amount: 25,
      kind: "adjustment" as const,
      action: "manual_adjustment",
      reason: "Goodwill after outage",
      actor: { type: "user" as const, id: "u-1" },
      idempotencyKey: "adj-1",
    };
    const first = await postCreditTransaction(db, input);
    const results = await Promise.all([postCreditTransaction(db, input), postCreditTransaction(db, input)]);
    expect(first.replayed).toBe(false);
    expect(results.every((r) => r.replayed && r.transaction.id === first.transaction.id)).toBe(true);
    const [wallet] = await sql`select balance from credit_balances where workspace_id = ${ws}`;
    expect(wallet!.balance).toBe(125);
  });

  it("concurrent spends are serialised: none lost, never overdrawn", async () => {
    const ws = await newWorkspace();
    await postCreditTransaction(db, { workspaceId: ws, amount: 10, kind: "grant", action: "provision" });
    const attempts = await Promise.allSettled(
      Array.from({ length: 15 }, () => postCreditTransaction(db, { workspaceId: ws, amount: -1, kind: "consume", action: "search" }))
    );
    const ok = attempts.filter((a) => a.status === "fulfilled").length;
    const refused = attempts.filter((a) => a.status === "rejected" && (a.reason as CreditLedgerError).code === "INSUFFICIENT_CREDITS").length;
    expect([ok, refused]).toEqual([10, 5]);
    const [wallet] = await sql`select balance from credit_balances where workspace_id = ${ws}`;
    expect(wallet!.balance).toBe(0);
  });

  it("validates kind sign, reason on manual entries, and compensation targets", async () => {
    const ws = await newWorkspace();
    await expect(postCreditTransaction(db, { workspaceId: ws, amount: -5, kind: "grant", action: "x" })).rejects.toMatchObject({
      code: "INVALID_CREDIT_TRANSACTION",
    });
    await expect(postCreditTransaction(db, { workspaceId: ws, amount: 5, kind: "adjustment", action: "x" })).rejects.toThrow(/reason/);
    await expect(
      postCreditTransaction(db, { workspaceId: ws, amount: 5, kind: "grant", action: "x", actor: { type: "user", id: "u" } })
    ).rejects.toThrow(/reason/);
    await expect(
      postCreditTransaction(db, { workspaceId: ws, amount: 5, kind: "adjustment", action: "x", reason: "r", compensatesId: randomUUID() })
    ).rejects.toThrow(/compensates_id/);
  });

  it("a correction is a compensating entry that points at the original", async () => {
    const ws = await newWorkspace();
    const wrong = await postCreditTransaction(db, {
      workspaceId: ws,
      amount: 1000,
      kind: "grant",
      action: "complimentary",
      reason: "Typo: meant 100",
      actor: { type: "user", id: "u-1" },
    });
    const fix = await postCreditTransaction(db, {
      workspaceId: ws,
      amount: -900,
      kind: "adjustment",
      action: "correction",
      reason: "Correct the 1000 grant to 100",
      actor: { type: "user", id: "u-1" },
      compensatesId: wrong.transaction.id,
    });
    expect(fix.balance).toBe(100);
    const rows = await sql`select amount, compensates_id from credit_transactions where workspace_id = ${ws} order by seq`;
    expect(rows.map((r) => [r.amount, r.compensates_id])).toEqual([
      [1000, null],
      [-900, wrong.transaction.id],
    ]);
  });

  it("reconciliation detects a wallet that drifted from its ledger and records the run", async () => {
    const ws = await newWorkspace();
    await postCreditTransaction(db, { workspaceId: ws, amount: 300, kind: "grant", action: "provision" });
    expect((await reconcileCreditLedger(db, { workspaceId: ws })).mismatches).toEqual([]);

    // Corrupt the stored balance directly (the ledger rows themselves cannot be changed).
    await sql`update credit_balances set balance = 999 where workspace_id = ${ws}`;
    const report = await reconcileCreditLedger(db, { workspaceId: ws, record: true, triggeredBy: "test" });
    expect(report.mismatches).toEqual([
      { workspace_id: ws, balance: 999, ledger_sum: 300, last_balance_after: 300, problem: "balance_differs_from_ledger" },
    ]);
    const [run] = await sql`select mismatch_count, triggered_by from credit_reconciliation_runs where id = ${report.runId}`;
    expect(run).toEqual({ mismatch_count: 1, triggered_by: "test" });
  });

  it("workspace deletion still cascades through the append-only ledger", async () => {
    const ws = randomUUID();
    await sql`insert into workspaces (id, name, slug) values (${ws}, 'Cascade', ${"cascade-" + ws})`;
    await postCreditTransaction(db, { workspaceId: ws, amount: 5, kind: "grant", action: "provision" });
    await sql`delete from workspaces where id = ${ws}`;
    const [left] = await sql`select count(*)::int n from credit_transactions where workspace_id = ${ws}`;
    expect(left!.n).toBe(0);
  });
});
