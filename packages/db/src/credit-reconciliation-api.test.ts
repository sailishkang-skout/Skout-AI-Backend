import { afterAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { createDb } from "./client.js";
import { postCreditTransaction, reconcileApiCredits, reconcileCreditLedger } from "./credit-ledger.js";

/**
 * PAPI-035 against a real, migrated Postgres (COPS_TEST_DATABASE_URL): the nightly reconciliation
 * covers public API holds, charges and keys, and flags each deliberately corrupted fixture.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("public API credit reconciliation (PAPI-035)", () => {
  const { db, sql: dbSql } = createDb(url as string);
  const sql = postgres(url as string, { max: 1, onnotice: () => {} });
  const created: string[] = [];

  async function workspace(credits = 100) {
    const ws = randomUUID();
    await sql`insert into workspaces (id, name, slug) values (${ws}, 'PAPI-035', ${"papi035-" + ws})`;
    created.push(ws);
    await postCreditTransaction(db, { workspaceId: ws, amount: credits, kind: "purchase", action: "test" });
    return ws;
  }
  async function key(ws: string) {
    const [k] = await sql`insert into api_keys (workspace_id, name, type, prefix, key_hmac, expires_at)
      values (${ws}, 'k', 'live', ${randomBytes(6).toString("hex")}, 'h', now() + interval '30 days') returning id`;
    return k!.id as string;
  }
  async function hold(ws: string, keyId: string, amount: number, status: "held" | "committed", expiresIn = "15 minutes") {
    const requestId = `req_${randomUUID()}`;
    const [h] = await sql`insert into credit_holds (workspace_id, api_key_id, request_id, amount, status, expires_at, settled_at)
      values (${ws}, ${keyId}, ${requestId}, ${amount}, ${status}, now() + ${expiresIn}::interval, ${status === "held" ? null : sql`now()`}) returning id`;
    return { holdId: h!.id as string, requestId };
  }
  const charge = (ws: string, keyId: string, requestId: string, credits: number, holdId?: string) =>
    postCreditTransaction(db, {
      workspaceId: ws,
      amount: -credits,
      kind: "consume",
      action: "api.people.lookup",
      category: "data",
      apiKeyId: keyId,
      referenceId: requestId,
      idempotencyKey: `api:${ws}:${requestId}`,
      settlesHoldId: holdId,
    });
  /** A correct API call: hold, then its charge, then the hold committed. */
  async function goodCall(ws: string, keyId: string, held: number, charged: number) {
    const h = await hold(ws, keyId, held, "held");
    await charge(ws, keyId, h.requestId, charged, h.holdId);
    await sql`update credit_holds set status = 'committed', settled_at = now() where id = ${h.holdId}`;
  }
  const problems = async (ws: string) => (await reconcileApiCredits(db, { workspaceId: ws })).map((m) => m.problem).sort();

  afterAll(async () => {
    for (const ws of created) await sql`delete from workspaces where id = ${ws}`;
    await sql.end();
    await dbSql.end();
  });

  it("finds nothing wrong with correct API calls, in-app spend and fresh holds", async () => {
    const ws = await workspace();
    const k = await key(ws);
    await goodCall(ws, k, 5, 3);
    await goodCall(ws, k, 1, 1);
    await hold(ws, k, 4, "held");
    await postCreditTransaction(db, { workspaceId: ws, amount: -2, kind: "consume", action: "search" });
    expect(await problems(ws)).toEqual([]);
    const report = await reconcileCreditLedger(db, { workspaceId: ws });
    expect(report.mismatches).toEqual([]);
    expect(report.apiMismatches).toEqual([]);
  });

  it("flags a committed hold that has no charge", async () => {
    const ws = await workspace();
    const k = await key(ws);
    const h = await hold(ws, k, 5, "committed");
    const found = await reconcileApiCredits(db, { workspaceId: ws });
    expect(found).toContainEqual(expect.objectContaining({ problem: "hold_committed_without_charge", hold_id: h.holdId, expected: 5, actual: 0 }));
  });

  it("flags a charge larger than its hold, and the key total that no longer matches", async () => {
    const ws = await workspace();
    const k = await key(ws);
    const h = await hold(ws, k, 2, "held");
    await charge(ws, k, h.requestId, 5, h.holdId);
    await sql`update credit_holds set status = 'committed', settled_at = now() where id = ${h.holdId}`;
    expect(await problems(ws)).toEqual(["charge_exceeds_hold"]);
  });

  it("flags an API charge with no hold behind it", async () => {
    const ws = await workspace();
    const k = await key(ws);
    await charge(ws, k, "req_orphan", 4);
    expect(await problems(ws)).toEqual(["api_key_total_differs", "charge_without_hold"]);
  });

  it("flags a charge booked to a different key than its hold, and a key from another workspace", async () => {
    const ws = await workspace();
    const other = await workspace();
    const [k1, k2, foreignKey] = [await key(ws), await key(ws), await key(other)];
    const h = await hold(ws, k1, 3, "held");
    await charge(ws, k2, h.requestId, 3, h.holdId);
    await sql`update credit_holds set status = 'committed', settled_at = now() where id = ${h.holdId}`;
    await postCreditTransaction(db, { workspaceId: ws, amount: -1, kind: "consume", action: "search", apiKeyId: foreignKey });
    const found = await problems(ws);
    expect(found).toContain("charge_key_differs_from_hold");
    expect(found).toContain("key_from_other_workspace");
    expect(found).toContain("api_key_total_differs");
  });

  it("flags a hold left 'held' over an hour after it expired (sweeper not running)", async () => {
    const ws = await workspace();
    const k = await key(ws);
    await hold(ws, k, 2, "held", "-2 hours");
    await hold(ws, k, 2, "held", "-10 minutes"); // the sweeper may simply not have run yet
    expect(await problems(ws)).toEqual(["stale_hold"]);
  });

  it("records API mismatches in the reconciliation run", async () => {
    const ws = await workspace();
    const k = await key(ws);
    await hold(ws, k, 7, "committed");
    const report = await reconcileCreditLedger(db, { workspaceId: ws, record: true, triggeredBy: "test" });
    expect(report.apiMismatches).toHaveLength(1);
    const [run] = await sql`select mismatch_count, mismatches from credit_reconciliation_runs where id = ${report.runId}`;
    expect(run!.mismatch_count).toBe(1);
    expect(run!.mismatches).toEqual([expect.objectContaining({ problem: "hold_committed_without_charge", workspace_id: ws })]);
  });
});
