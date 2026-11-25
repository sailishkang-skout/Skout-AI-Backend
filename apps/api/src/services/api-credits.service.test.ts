import { afterAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createDb, postCreditTransaction, schema } from "@skout/db";
import { availableCredits, commit, release, reserve, InsufficientApiCreditsError, apiChargeIdempotencyKey } from "./api-credits.service.js";

/** PAPI-031 against a real, migrated Postgres: reserve → commit → release on the shared wallet. */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("public API credits: reserve, commit, release (PAPI-031)", () => {
  const { db, sql } = createDb(url as string);
  const created: string[] = [];

  async function walletWith(credits: number) {
    const ws = randomUUID();
    await db.insert(schema.workspaces).values({ id: ws, name: "PAPI-031", slug: `papi031-${ws}` });
    created.push(ws);
    const [key] = await db
      .insert(schema.apiKeys)
      .values({ workspaceId: ws, name: "k", type: "live", prefix: randomBytes(6).toString("hex"), keyHmac: "h", expiresAt: new Date(Date.now() + 30 * 86_400_000) })
      .returning();
    if (credits > 0) await postCreditTransaction(db, { workspaceId: ws, amount: credits, kind: "purchase", action: "test_purchase" });
    return { ws, keyId: key!.id };
  }
  const ledger = (ws: string) => db.select().from(schema.creditTransactions).where(eq(schema.creditTransactions.workspaceId, ws));

  afterAll(async () => {
    for (const ws of created) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, ws));
    await sql.end();
  });

  it("lets exactly one of two concurrent reservations through when together they exceed the balance", async () => {
    const { ws, keyId } = await walletWith(10);
    const results = await Promise.allSettled([
      reserve(db, { workspaceId: ws, apiKeyId: keyId, requestId: "req_a", max: 8 }),
      reserve(db, { workspaceId: ws, apiKeyId: keyId, requestId: "req_b", max: 8 }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(InsufficientApiCreditsError);
    expect(rejected.reason).toMatchObject({ statusCode: 402, message: "insufficient_credits" });
    expect(await availableCredits(db, ws)).toEqual({ balance: 10, held: 8, available: 2 });
  });

  it("never over-reserves under heavier concurrency", async () => {
    const { ws, keyId } = await walletWith(10);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => reserve(db, { workspaceId: ws, apiKeyId: keyId, requestId: `req_${i}`, max: 3 }))
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect((await availableCredits(db, ws)).held).toBe(9);
  });

  it("commits less than the hold: charges the actual amount once, as a data ledger row for the key", async () => {
    const { ws, keyId } = await walletWith(20);
    const hold = await reserve(db, { workspaceId: ws, apiKeyId: keyId, requestId: "req_search_1", max: 20 });
    const res = await commit(db, hold.holdId, 3, "search.index_page");
    expect(res).toEqual({ charged: 3, balance: 17, alreadyCommitted: false });
    expect(await availableCredits(db, ws)).toEqual({ balance: 17, held: 0, available: 17 });
    const rows = (await ledger(ws)).filter((r) => r.kind === "consume");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      amount: -3,
      category: "data",
      action: "api.search.index_page",
      apiKeyId: keyId,
      referenceId: "req_search_1",
      idempotencyKey: apiChargeIdempotencyKey(ws, "req_search_1"),
      balanceAfter: 17,
    });
    const [h] = await db.select().from(schema.creditHolds).where(eq(schema.creditHolds.id, hold.holdId!));
    expect(h).toMatchObject({ status: "committed" });
    expect(h!.settledAt).toBeInstanceOf(Date);
  });

  it("charges a double commit only once, even when both run at the same time", async () => {
    const { ws, keyId } = await walletWith(10);
    const hold = await reserve(db, { workspaceId: ws, apiKeyId: keyId, requestId: "req_dbl", max: 5 });
    const [a, b] = await Promise.all([commit(db, hold.holdId, 4, "contacts.email_find"), commit(db, hold.holdId, 4, "contacts.email_find")]);
    expect([a.alreadyCommitted, b.alreadyCommitted].sort()).toEqual([false, true]);
    expect(await commit(db, hold.holdId, 4, "contacts.email_find")).toMatchObject({ charged: 0, alreadyCommitted: true });
    expect((await ledger(ws)).filter((r) => r.kind === "consume")).toHaveLength(1);
    expect((await availableCredits(db, ws)).balance).toBe(6);
  });

  it("ignores a release after a commit, and refuses a commit after a release", async () => {
    const { ws, keyId } = await walletWith(10);
    const committed = await reserve(db, { workspaceId: ws, apiKeyId: keyId, requestId: "req_c", max: 4 });
    await commit(db, committed.holdId, 2, "people.lookup");
    expect(await release(db, committed.holdId)).toEqual({ released: false });
    const [h] = await db.select().from(schema.creditHolds).where(eq(schema.creditHolds.id, committed.holdId!));
    expect(h!.status).toBe("committed");
    expect((await availableCredits(db, ws)).balance).toBe(8);

    const failed = await reserve(db, { workspaceId: ws, apiKeyId: keyId, requestId: "req_f", max: 4 });
    expect((await availableCredits(db, ws)).available).toBe(4);
    expect(await release(db, failed.holdId)).toEqual({ released: true });
    expect(await release(db, failed.holdId)).toEqual({ released: false });
    expect((await availableCredits(db, ws)).available).toBe(8);
    await expect(commit(db, failed.holdId, 1, "people.lookup")).rejects.toMatchObject({ statusCode: 409 });
    expect((await ledger(ws)).filter((r) => r.kind === "consume")).toHaveLength(1);
  });

  it("returns the existing hold for a retried request, refuses before any work when broke, and skips free calls", async () => {
    const { ws, keyId } = await walletWith(5);
    const first = await reserve(db, { workspaceId: ws, apiKeyId: keyId, requestId: "req_retry", max: 4 });
    const again = await reserve(db, { workspaceId: ws, apiKeyId: keyId, requestId: "req_retry", max: 4 });
    expect(again).toEqual({ holdId: first.holdId, amount: 4, existing: true });
    await expect(reserve(db, { workspaceId: ws, apiKeyId: keyId, requestId: "req_more", max: 2 })).rejects.toMatchObject({ statusCode: 402, details: { available: 1, required: 2 } });
    expect(await reserve(db, { workspaceId: ws, apiKeyId: keyId, requestId: "req_free", max: 0 })).toEqual({ holdId: null, amount: 0, existing: false });
    expect(await commit(db, null, 0, "emails.verify")).toMatchObject({ charged: 0 });
    await expect(commit(db, first.holdId, 5, "people.lookup")).rejects.toThrow(/more than the 4 credits held/);
    expect(await commit(db, first.holdId, 0, "people.lookup")).toMatchObject({ charged: 0 }); // no result: released
    expect((await availableCredits(db, ws)).available).toBe(5);

    const empty = await walletWith(0);
    await expect(reserve(db, { workspaceId: empty.ws, apiKeyId: empty.keyId, requestId: "r", max: 1 })).rejects.toBeInstanceOf(InsufficientApiCreditsError);
  });

  it("doesn't count expired holds against the balance", async () => {
    const { ws, keyId } = await walletWith(10);
    const old = new Date(Date.now() - 20 * 60_000);
    await reserve(db, { workspaceId: ws, apiKeyId: keyId, requestId: "req_old", max: 9 }, old);
    expect((await availableCredits(db, ws)).available).toBe(10);
    await expect(reserve(db, { workspaceId: ws, apiKeyId: keyId, requestId: "req_new", max: 9 })).resolves.toMatchObject({ amount: 9 });
    const holds = await db.select().from(schema.creditHolds).where(and(eq(schema.creditHolds.workspaceId, ws), eq(schema.creditHolds.status, "held")));
    expect(holds).toHaveLength(2);
  });
});
