import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type Db } from "@skout/db";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { PublicKeyCache, createMemoryInvalidationBus, setPublicKeyInvalidator, clearPublicKeyInvalidator, type KeyInvalidation } from "./public-key-cache.js";
import { createPublicApiKey, parsePublicApiKey, revokePublicApiKey, rotatePublicApiKey, verifyPublicApiKey, type KeyServiceConfig } from "../services/public-api-keys.service.js";
import { disableAddon } from "../services/public-api-addon.service.js";

/** PAPI-023 (KEY-9): cached key lookups, and revocation reaching every instance within 5 seconds. */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const PEPPER = randomBytes(32).toString("base64");

async function within(ms: number, check: () => Promise<boolean>): Promise<number> {
  const start = Date.now();
  for (;;) {
    if (await check()) return Date.now() - start;
    if (Date.now() - start > ms) throw new Error(`not true within ${ms} ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function seedWorkspace(db: Db, label: string) {
  const ws = randomUUID();
  await db.insert(schema.workspaces).values({ id: ws, name: label, slug: `${label}-${ws}` });
  const [u] = await db.insert(schema.users).values({ email: `${label}-${ws.slice(0, 8)}@test.com`, isActive: true }).returning();
  await db.insert(schema.workspaceApiSettings).values({ workspaceId: ws, addonEnabled: true });
  return { ws, userId: u!.id };
}

maybe("public key cache with two instances on a shared bus", () => {
  const { db, sql } = createDb(url as string);
  const bus = createMemoryInvalidationBus();
  const instanceA = new PublicKeyCache(db, { bus });
  const instanceB = new PublicKeyCache(db, { bus });
  const cfgA: KeyServiceConfig = { pepper: PEPPER, maxActiveKeys: 10, lookup: (p) => instanceA.get(p) };
  const cfgB: KeyServiceConfig = { pepper: PEPPER, maxActiveKeys: 10, lookup: (p) => instanceB.get(p) };
  const invalidate = (msg: KeyInvalidation) => instanceA.invalidate(msg);
  let seed: { ws: string; userId: string };

  beforeAll(async () => {
    await instanceA.start();
    await instanceB.start();
    setPublicKeyInvalidator(invalidate); // revoke/rotate/disable announce through instance A
    seed = await seedWorkspace(db, "papi023");
  });

  afterAll(async () => {
    clearPublicKeyInvalidator(invalidate);
    await instanceA.stop();
    await instanceB.stop();
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, seed.ws));
    await db.delete(schema.users).where(eq(schema.users.id, seed.userId));
    await sql.end();
  });

  const newKey = () =>
    createPublicApiKey(db, { pepper: PEPPER, maxActiveKeys: 10 }, { workspaceId: seed.ws, userId: seed.userId }, { name: "k", type: "live", scopes: ["search:read"] });

  it("serves repeat lookups from memory: a database change alone isn't seen until the TTL or an invalidation", async () => {
    const created = await newKey();
    expect((await verifyPublicApiKey(db, cfgA, created.key)).ok).toBe(true);
    // Revoke straight in the database, with no announcement: instance A still has it cached.
    await db.update(schema.apiKeys).set({ revokedAt: new Date(), revokeReason: "silent" }).where(eq(schema.apiKeys.id, created.id));
    expect((await verifyPublicApiKey(db, cfgA, created.key)).ok).toBe(true);
    // A fresh lookup (instance B never cached it) sees the truth.
    expect(await verifyPublicApiKey(db, cfgB, created.key)).toEqual({ ok: false, error: "key_revoked" });
    await instanceA.invalidate({ prefixes: [parsePublicApiKey(created.key)!.prefix] });
    expect(await verifyPublicApiKey(db, cfgA, created.key)).toEqual({ ok: false, error: "key_revoked" });
  });

  it("a revoked key fails on both instances within 5 seconds", async () => {
    const created = await newKey();
    expect((await verifyPublicApiKey(db, cfgA, created.key)).ok).toBe(true);
    expect((await verifyPublicApiKey(db, cfgB, created.key)).ok).toBe(true);
    await revokePublicApiKey(db, { workspaceId: seed.ws, userId: seed.userId }, created.id, "leaked");
    const tookA = await within(5000, async () => !(await verifyPublicApiKey(db, cfgA, created.key)).ok);
    const tookB = await within(5000, async () => !(await verifyPublicApiKey(db, cfgB, created.key)).ok);
    expect(tookA).toBeLessThan(5000);
    expect(tookB).toBeLessThan(5000);
  });

  it("a rotation with no grace and a disabled add-on reach both instances too", async () => {
    const created = await newKey();
    await verifyPublicApiKey(db, cfgB, created.key);
    await rotatePublicApiKey(db, { pepper: PEPPER, maxActiveKeys: 10 }, { workspaceId: seed.ws, userId: seed.userId }, created.id, 0);
    await within(5000, async () => !(await verifyPublicApiKey(db, cfgB, created.key)).ok);

    const another = await newKey();
    const before = await verifyPublicApiKey(db, cfgB, another.key);
    expect(before.ok && before.addonEnabled).toBe(true);
    await disableAddon(db, { workspaceId: seed.ws, actorId: "ops-1", actorType: "staff", reason: "test" });
    await within(5000, async () => {
      const r = await verifyPublicApiKey(db, cfgB, another.key);
      return r.ok && r.addonEnabled === false;
    });
    await db.update(schema.workspaceApiSettings).set({ addonEnabled: true }).where(eq(schema.workspaceApiSettings.workspaceId, seed.ws));
  });

  it("never caches for longer than 60 seconds", async () => {
    let now = Date.now();
    const timed = new PublicKeyCache(db, { bus: createMemoryInvalidationBus(), ttlMs: 10 * 60_000, clock: () => now });
    const created = await newKey();
    const prefix = parsePublicApiKey(created.key)!.prefix;
    expect((await timed.get(prefix))!.key.revokedAt).toBeNull();
    await db.update(schema.apiKeys).set({ revokedAt: new Date(), revokeReason: "silent" }).where(eq(schema.apiKeys.id, created.id));
    now += 59_000;
    expect((await timed.get(prefix))!.key.revokedAt).toBeNull();
    now += 2_000;
    expect((await timed.get(prefix))!.key.revokedAt).not.toBeNull();
  });
});

/** Two real app instances sharing Postgres and Redis (pub/sub). Skipped when Redis isn't reachable (CI has none). */
const redisUrl = process.env.PAPI_TEST_REDIS_URL ?? "redis://127.0.0.1:6379";
async function redisUp(): Promise<boolean> {
  const r = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 0, connectTimeout: 500, retryStrategy: () => null });
  r.on("error", () => undefined);
  try {
    await r.connect();
    return (await r.ping()) === "PONG";
  } catch {
    return false;
  } finally {
    r.disconnect();
  }
}
const withRedis = url && (await redisUp()) ? describe : describe.skip;

withRedis("two app instances over Redis pub/sub", () => {
  let app1: FastifyInstance;
  let app2: FastifyInstance;
  let seed: { ws: string; userId: string };

  beforeAll(async () => {
    const config = loadEnv();
    const base = { ...config, DATABASE_URL: url!, REDIS_URL: redisUrl, CLERK_SECRET_KEY: undefined, LOG_LEVEL: "fatal" as const, OPENSEARCH_URL: undefined };
    app1 = await buildApp(base);
    app2 = await buildApp(base);
    seed = await seedWorkspace(app1.db!, "papi023r");
  }, 60000);

  afterAll(async () => {
    await app1.db!.delete(schema.workspaces).where(eq(schema.workspaces.id, seed.ws));
    await app1.db!.delete(schema.users).where(eq(schema.users.id, seed.userId));
    await app2?.close();
    await app1?.close();
  });

  it("a key revoked through one instance fails on both within 5 seconds", async () => {
    const created = await createPublicApiKey(app1.db!, { pepper: PEPPER, maxActiveKeys: 10 }, { workspaceId: seed.ws, userId: seed.userId }, { name: "k", type: "live", scopes: ["search:read"] });
    const cfg = (app: FastifyInstance): KeyServiceConfig => ({ pepper: PEPPER, maxActiveKeys: 10, lookup: (p) => app.publicKeyCache!.get(p) });
    expect((await verifyPublicApiKey(app1.db!, cfg(app1), created.key)).ok).toBe(true);
    expect((await verifyPublicApiKey(app2.db!, cfg(app2), created.key)).ok).toBe(true);
    await revokePublicApiKey(app1.db!, { workspaceId: seed.ws, userId: seed.userId }, created.id, "leaked");
    for (const app of [app1, app2]) {
      const took = await within(5000, async () => !(await verifyPublicApiKey(app.db!, cfg(app), created.key)).ok);
      expect(took).toBeLessThan(5000);
    }
  });
});
