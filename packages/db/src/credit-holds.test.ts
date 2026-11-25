import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { createDb, type Db } from "./client.js";
import { postCreditTransaction } from "./credit-ledger.js";

/**
 * PAPI-011 against a real, migrated Postgres (COPS_TEST_DATABASE_URL): credit_holds constraints,
 * the api_key_id link on the ledger, and the ledger staying append-only.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("PAPI-011 credit holds and ledger api_key_id", () => {
  let db: Db;
  let sql: ReturnType<typeof postgres>;
  let close: () => Promise<void>;
  const created: string[] = [];

  async function workspaceWithKey() {
    const ws = randomUUID();
    await sql`insert into workspaces (id, name, slug) values (${ws}, 'PAPI-011 test', ${"papi011-" + ws})`;
    created.push(ws);
    const [key] = await sql`
      insert into api_keys (workspace_id, name, type, prefix, key_hmac, expires_at)
      values (${ws}, 'k', 'live', ${randomBytes(6).toString("hex")}, 'hmac', now() + interval '30 days')
      returning id`;
    return { ws, keyId: key!.id as string };
  }
  const hold = (ws: string, keyId: string, over: { requestId?: string; amount?: number; status?: string; settled?: boolean } = {}) =>
    sql`
      insert into credit_holds (workspace_id, api_key_id, request_id, amount, status, expires_at, settled_at)
      values (${ws}, ${keyId}, ${over.requestId ?? randomUUID()}, ${over.amount ?? 5}, ${over.status ?? "held"},
              now() + interval '15 minutes', ${over.settled ? sql`now()` : null})
      returning id, status`;

  beforeAll(() => {
    const c = createDb(url as string);
    db = c.db;
    close = () => c.sql.end();
    sql = postgres(url as string, { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    for (const id of created) await sql`delete from workspaces where id = ${id}`;
    await sql.end();
    await close();
  });

  it("takes a hold and allows one hold per request", async () => {
    const { ws, keyId } = await workspaceWithKey();
    const [h] = await hold(ws, keyId, { requestId: "req_1" });
    expect(h!.status).toBe("held");
    await expect(hold(ws, keyId, { requestId: "req_1" })).rejects.toThrow(/credit_holds_workspace_request_uq/);
  });

  it("rejects bad amounts, unknown statuses and settled/held mismatches", async () => {
    const { ws, keyId } = await workspaceWithKey();
    await expect(hold(ws, keyId, { amount: 0 })).rejects.toThrow(/credit_holds_amount_check/);
    await expect(hold(ws, keyId, { status: "pending", settled: true })).rejects.toThrow(/credit_holds_status_check/);
    await expect(hold(ws, keyId, { status: "committed" })).rejects.toThrow(/credit_holds_settled_check/);
    await expect(hold(ws, keyId, { status: "held", settled: true })).rejects.toThrow(/credit_holds_settled_check/);
    const [h] = await hold(ws, keyId);
    await sql`update credit_holds set status = 'released', settled_at = now() where id = ${h!.id}`;
  });

  it("records the API key and category on a ledger entry", async () => {
    const { ws, keyId } = await workspaceWithKey();
    await postCreditTransaction(db, { workspaceId: ws, amount: 100, kind: "grant", action: "provision" });
    const spent = await postCreditTransaction(db, {
      workspaceId: ws,
      amount: -3,
      kind: "consume",
      action: "api.people.search",
      category: "data",
      apiKeyId: keyId,
      referenceId: "req_abc",
      idempotencyKey: `api:${ws}:req_abc`,
    });
    expect(spent.transaction).toMatchObject({ apiKeyId: keyId, category: "data", balanceAfter: 97 });
  });

  it("keeps the ledger append-only, including the new column", async () => {
    const { ws, keyId } = await workspaceWithKey();
    const { transaction } = await postCreditTransaction(db, { workspaceId: ws, amount: 10, kind: "grant", action: "provision" });
    await expect(sql`update credit_transactions set api_key_id = ${keyId} where id = ${transaction.id}`).rejects.toThrow(/append-only/);
    await expect(sql`delete from credit_transactions where id = ${transaction.id}`).rejects.toThrow(/append-only/);
  });

  it("refuses to delete a key that spent credits on its own, but the workspace still deletes cleanly", async () => {
    const { ws, keyId } = await workspaceWithKey();
    await postCreditTransaction(db, { workspaceId: ws, amount: 10, kind: "grant", action: "provision" });
    await postCreditTransaction(db, { workspaceId: ws, amount: -1, kind: "consume", action: "api.x", apiKeyId: keyId, category: "data" });
    await hold(ws, keyId);
    await expect(sql`delete from api_keys where id = ${keyId}`).rejects.toThrow(/credit_transactions_api_key_id_fk/);
    await sql`delete from workspaces where id = ${ws}`;
    const [left] = await sql`
      select (select count(*) from credit_transactions where workspace_id = ${ws})::int as ledger,
             (select count(*) from credit_holds where workspace_id = ${ws})::int as holds,
             (select count(*) from api_keys where workspace_id = ${ws})::int as keys`;
    expect(left).toEqual({ ledger: 0, holds: 0, keys: 0 });
  });
});
