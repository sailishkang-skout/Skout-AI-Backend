import { afterAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import { createDb, postCreditTransaction, schema } from "@skout/db";
import { commit, reserve } from "./api-credits.service.js";
import { CapReachedError, QuotaReachedError, consumeQuota, limitsForKey, nextUtcDayStart, nextUtcMonthStart, utcDayStart, utcMonthStart } from "./api-limits.service.js";
import { createMemoryQuotaStore, createRedisQuotaStore, type QuotaStore } from "../lib/api-quota.js";

const DAY = 86_400_000;

describe("UTC periods", () => {
  it("start at UTC midnight and on the 1st of the month", () => {
    const t = new Date("2026-11-30T23:59:59.999Z");
    expect(utcDayStart(t).toISOString()).toBe("2026-11-30T00:00:00.000Z");
    expect(nextUtcDayStart(t).toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(utcMonthStart(t).toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(nextUtcMonthStart(new Date("2026-12-15T10:00:00Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});

function quotaSuite(name: string, makeStore: () => Promise<QuotaStore | null>) {
  describe(`daily quotas (${name})`, async () => {
    const store = await makeStore();
    const run = store ? it : it.skip;
    const limits = { caps: {}, verifyDailyQuota: 5, searchDailyQuota: 50 };

    run("caps verifications per key per day, counts a batch in full, and resets at UTC midnight", async () => {
      const keyId = randomUUID();
      const day1 = new Date("2027-02-10T23:00:00Z");
      for (let i = 0; i < 5; i++) await consumeQuota(store!, "verify", keyId, 1, limits, day1);
      const err = await consumeQuota(store!, "verify", keyId, 1, limits, day1).catch((e) => e);
      expect(err).toBeInstanceOf(QuotaReachedError);
      expect(err).toMatchObject({ statusCode: 429, message: "quota_reached", details: { quota: "verify_daily", limit: 5, used: 5, resets_at: "2027-02-11T00:00:00.000Z" } });
      // A batch that doesn't fit is refused whole and takes nothing.
      const otherKey = randomUUID();
      await consumeQuota(store!, "verify", otherKey, 3, limits, day1);
      await expect(consumeQuota(store!, "verify", otherKey, 3, limits, day1)).rejects.toBeInstanceOf(QuotaReachedError);
      expect(await store!.used("verify", otherKey, day1)).toBe(3);
      // Next UTC day: fresh quota. Other keys never share it.
      const day2 = new Date("2027-02-11T00:00:01Z");
      await consumeQuota(store!, "verify", keyId, 5, limits, day2);
      await consumeQuota(store!, "verify", randomUUID(), 5, limits, day1);
    });

    run("caps search results per key per day and gives back what a page didn't use", async () => {
      const keyId = randomUUID();
      const now = new Date("2027-03-01T12:00:00Z");
      await consumeQuota(store!, "search_results", keyId, 25, limits, now);
      await store!.refund("search_results", keyId, 20, now); // the page returned 5
      await consumeQuota(store!, "search_results", keyId, 25, limits, now);
      await consumeQuota(store!, "search_results", keyId, 20, limits, now);
      expect(await store!.used("search_results", keyId, now)).toBe(50);
      const err = await consumeQuota(store!, "search_results", keyId, 1, limits, now).catch((e) => e);
      expect(err).toMatchObject({ statusCode: 429, details: { quota: "search_results_daily", limit: 50 } });
      await store!.refund("search_results", keyId, 1000, now);
      expect(await store!.used("search_results", keyId, now)).toBe(0);
    });

    run("never lets parallel requests pass the quota together", async () => {
      const keyId = randomUUID();
      const now = new Date("2027-04-01T08:00:00Z");
      const results = await Promise.allSettled(Array.from({ length: 12 }, () => consumeQuota(store!, "verify", keyId, 1, limits, now)));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    });
  });
}

quotaSuite("memory", async () => createMemoryQuotaStore());
quotaSuite("Redis", async () => {
  const redis = new Redis(process.env.PAPI_TEST_REDIS_URL ?? "redis://127.0.0.1:6379", {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    connectTimeout: 500,
    retryStrategy: () => null,
  });
  redis.on("error", () => undefined);
  const up = await redis.connect().then(() => true, () => false);
  if (!up) return null;
  afterAll(() => redis.disconnect());
  return createRedisQuotaStore(redis);
});

const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("credit caps (PAPI-033, Postgres)", () => {
  const { db, sql } = createDb(url as string);
  const created: string[] = [];
  async function setup(credits = 1000) {
    const ws = randomUUID();
    await db.insert(schema.workspaces).values({ id: ws, name: "PAPI-033", slug: `papi033-${ws}` });
    created.push(ws);
    const mk = async () =>
      (
        await db
          .insert(schema.apiKeys)
          .values({ workspaceId: ws, name: "k", type: "live", prefix: randomBytes(6).toString("hex"), keyHmac: "h", expiresAt: new Date(Date.now() + 30 * DAY) })
          .returning()
      )[0]!;
    await postCreditTransaction(db, { workspaceId: ws, amount: credits, kind: "purchase", action: "test" });
    return { ws, keyA: await mk(), keyB: await mk() };
  }
  const spend = async (ws: string, keyId: string, credits: number, caps: object, now = new Date()) => {
    const h = await reserve(db, { workspaceId: ws, apiKeyId: keyId, requestId: randomUUID(), max: credits, caps }, now);
    await commit(db, h.holdId, credits, "people.lookup");
  };

  afterAll(async () => {
    for (const ws of created) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, ws));
    await sql.end();
  });

  it("enforces a key's daily cap, counting held credits, and resets at UTC midnight", async () => {
    const { ws, keyA } = await setup();
    const caps = { keyDaily: 10 };
    await spend(ws, keyA.id, 6, caps);
    // 6 spent + 3 held for an in-flight request: 2 more would make 11.
    await reserve(db, { workspaceId: ws, apiKeyId: keyA.id, requestId: "in-flight", max: 3, caps });
    const err = await reserve(db, { workspaceId: ws, apiKeyId: keyA.id, requestId: randomUUID(), max: 2, caps }).catch((e) => e);
    expect(err).toBeInstanceOf(CapReachedError);
    expect(err).toMatchObject({ statusCode: 429, message: "cap_reached", details: { cap: "key_daily", limit: 10, used: 9, resets_at: nextUtcDayStart(new Date()).toISOString() } });
    await reserve(db, { workspaceId: ws, apiKeyId: keyA.id, requestId: randomUUID(), max: 1, caps });
    // Tomorrow (UTC) the same key may spend again.
    const tomorrow = new Date(utcDayStart(new Date()).getTime() + DAY + 60_000);
    await expect(reserve(db, { workspaceId: ws, apiKeyId: keyA.id, requestId: randomUUID(), max: 10, caps }, tomorrow)).resolves.toMatchObject({ amount: 10 });
  });

  it("enforces a key's monthly cap and resets on the 1st (UTC)", async () => {
    const { ws, keyA, keyB } = await setup();
    const caps = { keyMonthly: 20 };
    await spend(ws, keyA.id, 15, caps);
    await expect(reserve(db, { workspaceId: ws, apiKeyId: keyA.id, requestId: randomUUID(), max: 6, caps })).rejects.toMatchObject({ details: { cap: "key_monthly", limit: 20, used: 15 } });
    // Another key in the workspace has its own cap.
    await reserve(db, { workspaceId: ws, apiKeyId: keyB.id, requestId: randomUUID(), max: 20, caps });
    const nextMonth = new Date(nextUtcMonthStart(new Date()).getTime() + 60_000);
    await expect(reserve(db, { workspaceId: ws, apiKeyId: keyA.id, requestId: randomUUID(), max: 20, caps }, nextMonth)).resolves.toMatchObject({ amount: 20 });
  });

  it("enforces the workspace's monthly API cap across all keys, ignoring in-app spend", async () => {
    const { ws, keyA, keyB } = await setup();
    const caps = { workspaceMonthly: 30 };
    await spend(ws, keyA.id, 12, caps);
    await spend(ws, keyB.id, 12, caps);
    await postCreditTransaction(db, { workspaceId: ws, amount: -100, kind: "consume", action: "search" }); // in-app: doesn't count
    const err = await reserve(db, { workspaceId: ws, apiKeyId: keyA.id, requestId: randomUUID(), max: 7, caps }).catch((e) => e);
    expect(err).toMatchObject({ statusCode: 429, details: { cap: "workspace_monthly", limit: 30, used: 24 } });
    await reserve(db, { workspaceId: ws, apiKeyId: keyB.id, requestId: randomUUID(), max: 6, caps });
  });

  it("lets only as many parallel reservations through as fit the cap", async () => {
    const { ws, keyA } = await setup();
    const caps = { keyDaily: 10 };
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => reserve(db, { workspaceId: ws, apiKeyId: keyA.id, requestId: randomUUID(), max: 3, caps })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
  });

  it("reads limits from the key, then the workspace settings, then the defaults", async () => {
    const { ws, keyA } = await setup();
    const defaults = { verifyDailyQuota: 5000, searchDailyQuota: 10000 };
    const key = { workspaceId: ws, dailyCreditCap: 50, monthlyCreditCap: null };
    expect(await limitsForKey(db, defaults, key)).toEqual({ caps: { keyDaily: 50, keyMonthly: null, workspaceMonthly: null }, verifyDailyQuota: 5000, searchDailyQuota: 10000 });
    await db.insert(schema.workspaceApiSettings).values({ workspaceId: ws, verifyDailyQuota: 100, monthlyCreditCap: 900 });
    expect(await limitsForKey(db, defaults, key)).toEqual({ caps: { keyDaily: 50, keyMonthly: null, workspaceMonthly: 900 }, verifyDailyQuota: 100, searchDailyQuota: 10000 });
    expect(keyA.id).toBeTruthy();
  });
});
