import { afterAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createDb, maintainPublicApiTables, postCreditTransaction, schema } from "@skout/db";
import { availableCredits } from "./api-credits.service.js";
import { cachedDatumCount, deliverBillableDatum, forgetSubject } from "./api-datum-cache.service.js";

/** PAPI-034 against a real, migrated Postgres: the 30-day "same datum, no charge" rule. */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const DAY = 86_400_000;

maybe("30-day cache-hit rule (PAPI-034, CRED-4)", () => {
  const { db, sql } = createDb(url as string);
  const created: string[] = [];

  async function setup() {
    const ws = randomUUID();
    await db.insert(schema.workspaces).values({ id: ws, name: "PAPI-034", slug: `papi034-${ws}` });
    created.push(ws);
    const [key] = await db
      .insert(schema.apiKeys)
      .values({ workspaceId: ws, name: "k", type: "live", prefix: randomBytes(6).toString("hex"), keyHmac: "h", expiresAt: new Date(Date.now() + 30 * DAY) })
      .returning();
    await postCreditTransaction(db, { workspaceId: ws, amount: 100, kind: "purchase", action: "test" });
    return { ws, keyId: key!.id };
  }
  const charges = (ws: string) =>
    db.select().from(schema.creditTransactions).where(and(eq(schema.creditTransactions.workspaceId, ws), eq(schema.creditTransactions.kind, "consume")));

  afterAll(async () => {
    for (const ws of created) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, ws));
    await sql.end();
  });

  it("charges a second email find for the same person 0 and returns the same email", async () => {
    const { ws, keyId } = await setup();
    let providerCalls = 0;
    const find = (requestId: string, now?: Date) =>
      deliverBillableDatum(
        db,
        {
          workspaceId: ws,
          apiKeyId: keyId,
          requestId,
          subjectKey: "person:ada-lovelace",
          type: "email",
          operation: "contacts.email_find",
          price: 1,
          fetch: async () => {
            providerCalls++;
            return { email: `ada${providerCalls}@example.com`, status: "valid" };
          },
        },
        now
      );

    const first = await find("req_1");
    expect(first).toEqual({ value: { email: "ada1@example.com", status: "valid" }, charged: 1, cacheHit: false });
    const second = await find("req_2");
    expect(second).toEqual({ value: { email: "ada1@example.com", status: "valid" }, charged: 0, cacheHit: true });
    expect(providerCalls).toBe(1);
    expect(await charges(ws)).toHaveLength(1);
    expect((await availableCredits(db, ws)).balance).toBe(99);

    // Free repeats don't extend the window: 31 days after the charged delivery it's charged again.
    expect((await find("req_3", new Date(Date.now() + 29 * DAY))).charged).toBe(0);
    const later = await find("req_4", new Date(Date.now() + 31 * DAY));
    expect(later).toMatchObject({ charged: 1, cacheHit: false, value: { email: "ada2@example.com" } });
  });

  it("is per workspace, per subject and per datum type", async () => {
    const a = await setup();
    const b = await setup();
    const get = (w: { ws: string; keyId: string }, subjectKey: string, type: "email" | "phone") =>
      deliverBillableDatum(db, {
        workspaceId: w.ws,
        apiKeyId: w.keyId,
        requestId: randomUUID(),
        subjectKey,
        type,
        operation: type === "email" ? "contacts.email_find" : "contacts.phone_find",
        price: type === "email" ? 1 : 10,
        fetch: async () => ({ v: `${subjectKey}:${type}` }),
      });
    expect((await get(a, "person:1", "email")).charged).toBe(1);
    expect((await get(b, "person:1", "email")).charged).toBe(1); // another workspace pays
    expect((await get(a, "person:2", "email")).charged).toBe(1); // another person
    expect((await get(a, "person:1", "phone")).charged).toBe(10); // another datum type
    expect((await get(a, "person:1", "email")).charged).toBe(0);
  });

  it("charges nothing and caches nothing when the datum isn't found or the provider fails", async () => {
    const { ws, keyId } = await setup();
    const base = { workspaceId: ws, apiKeyId: keyId, subjectKey: "person:ghost", type: "phone" as const, operation: "contacts.phone_find" as const, price: 10 };
    expect(await deliverBillableDatum(db, { ...base, requestId: "r1", fetch: async () => null })).toEqual({ value: null, charged: 0, cacheHit: false });
    await expect(deliverBillableDatum(db, { ...base, requestId: "r2", fetch: async () => Promise.reject(new Error("provider down")) })).rejects.toThrow("provider down");
    expect(await charges(ws)).toHaveLength(0);
    expect(await availableCredits(db, ws)).toEqual({ balance: 100, held: 0, available: 100 });
    expect(await cachedDatumCount(db, ws)).toBe(0);
  });

  it("forgets a subject everywhere on DSAR, and the maintenance job purges expired rows", async () => {
    const a = await setup();
    const b = await setup();
    for (const w of [a, b]) {
      await deliverBillableDatum(db, { workspaceId: w.ws, apiKeyId: w.keyId, requestId: randomUUID(), subjectKey: "person:dsar", type: "email", operation: "contacts.email_find", price: 1, fetch: async () => ({ e: "x@y.z" }) });
    }
    expect(await forgetSubject(db, "person:dsar")).toBe(2);
    expect(await cachedDatumCount(db, a.ws)).toBe(0);

    await deliverBillableDatum(db, { workspaceId: a.ws, apiKeyId: a.keyId, requestId: randomUUID(), subjectKey: "company:acme", type: "company", operation: "companies.lookup", price: 1, fetch: async () => ({ name: "Acme" }) });
    const r = await maintainPublicApiTables(db, new Date(Date.now() + 31 * DAY));
    expect(r.datumCachePurged).toBeGreaterThanOrEqual(1);
    expect(await cachedDatumCount(db, a.ws)).toBe(0);
  });
});
