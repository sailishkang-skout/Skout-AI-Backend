import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { Redis } from "ioredis";
import { createMemoryRateLimiter, createRedisRateLimiter, ruleForTier, type PublicRateLimiter } from "./public-rate-limit.js";
import { securityPlugin } from "../plugins/security.js";

const rule = { perSecond: 4, perMinute: 6, batchPerMinute: 2 };
const at = (iso: string) => new Date(iso);

function limiterSuite(name: string, make: () => Promise<{ a: PublicRateLimiter; b: PublicRateLimiter } | null>) {
  describe(`public API rate limiter (${name})`, async () => {
    const pair = await make();
    const run = pair ? it : it.skip;

    run("allows a burst up to the per-second limit, then refuses with Retry-After 1, and resets next second", async () => {
      const key = randomUUID();
      const t = at("2027-01-01T10:00:05.100Z");
      for (let i = 0; i < 4; i++) expect((await pair!.a.hit(key, { batch: false, rule }, t)).ok).toBe(true);
      const over = await pair!.a.hit(key, { batch: false, rule }, t);
      expect(over).toMatchObject({ ok: false, retryAfterSeconds: 1, limit: 6 });
      expect((await pair!.a.hit(key, { batch: false, rule }, at("2027-01-01T10:00:06.100Z"))).ok).toBe(true);
    });

    run("enforces the per-minute limit with RateLimit values, and resets on the next minute", async () => {
      const key = randomUUID();
      const results = [];
      for (let i = 0; i < 7; i++) results.push(await pair!.a.hit(key, { batch: false, rule }, at(`2027-01-01T11:00:${String(10 + i * 2).padStart(2, "0")}.000Z`)));
      expect(results.map((r) => r.remaining)).toEqual([5, 4, 3, 2, 1, 0, 0]);
      expect(results[6]).toMatchObject({ ok: false, limit: 6, retryAfterSeconds: 38, resetSeconds: 38 });
      expect((await pair!.a.hit(key, { batch: false, rule }, at("2027-01-01T11:01:00.500Z"))).ok).toBe(true);
    });

    run("gives batch endpoints their own, lower per-minute window", async () => {
      const key = randomUUID();
      const t = (s: number) => at(`2027-01-01T12:00:${String(s).padStart(2, "0")}.000Z`);
      expect((await pair!.a.hit(key, { batch: true, rule }, t(1))).ok).toBe(true);
      expect((await pair!.a.hit(key, { batch: true, rule }, t(2))).ok).toBe(true);
      expect(await pair!.a.hit(key, { batch: true, rule }, t(3))).toMatchObject({ ok: false, limit: 2 });
      expect((await pair!.a.hit(key, { batch: false, rule }, t(4))).ok).toBe(true); // the normal window is separate
    });

    run("shares one counter between two instances", async () => {
      const key = randomUUID();
      const t = (s: number) => at(`2027-01-01T13:00:${String(s).padStart(2, "0")}.000Z`);
      for (let i = 0; i < 3; i++) expect((await pair!.a.hit(key, { batch: false, rule }, t(i * 2))).ok).toBe(true);
      for (let i = 3; i < 6; i++) expect((await pair!.b.hit(key, { batch: false, rule }, t(i * 2))).ok).toBe(true);
      expect((await pair!.a.hit(key, { batch: false, rule }, t(20))).ok).toBe(false);
      expect((await pair!.b.hit(key, { batch: false, rule }, t(22))).ok).toBe(false);
    });
  });
}

limiterSuite("memory, one shared instance", async () => {
  const one = createMemoryRateLimiter();
  return { a: one, b: one };
});

const redisUrl = process.env.PAPI_TEST_REDIS_URL ?? "redis://127.0.0.1:6379";
async function connect(): Promise<Redis | null> {
  const r = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 0, connectTimeout: 500, retryStrategy: () => null });
  r.on("error", () => undefined);
  return r.connect().then(
    () => r,
    () => null
  );
}
const clients: Redis[] = [];
afterAll(() => clients.forEach((c) => c.disconnect()));

limiterSuite("Redis, two instances", async () => {
  const [r1, r2] = [await connect(), await connect()];
  if (!r1 || !r2) return null;
  clients.push(r1, r2);
  return { a: createRedisRateLimiter(r1), b: createRedisRateLimiter(r2) };
});

describe("rate tiers", () => {
  it("multiply the base limits for higher tiers set by CustomerOps", () => {
    const base = { perSecond: 10, perMinute: 600, batchPerMinute: 10 };
    expect(ruleForTier(base, null)).toEqual(base);
    expect(ruleForTier(base, "standard")).toEqual(base);
    expect(ruleForTier(base, "high")).toEqual({ perSecond: 50, perMinute: 3000, batchPerMinute: 50 });
    expect(ruleForTier(base, "enterprise").perMinute).toBe(12000);
    expect(ruleForTier(base, "made-up")).toEqual(base);
  });
});

describe("global API limiter on Redis (security plugin)", async () => {
  const probe = await connect();
  if (probe) clients.push(probe);
  const run = probe ? it : it.skip;

  run("shares one counter between two app instances", async () => {
    const config = { NODE_ENV: "production", REDIS_URL: redisUrl, RATE_LIMIT_MAX: 3, RATE_LIMIT_WINDOW_MS: 60_000 } as never;
    const make = async () => {
      const app = Fastify();
      await app.register(securityPlugin, config);
      app.get("/api/v1/ping", async () => ({ ok: true }));
      await app.ready();
      return app;
    };
    const [one, two] = [await make(), await make()];
    const auth = { authorization: `Bearer test-${randomUUID()}` };
    try {
      const codes = [];
      for (const app of [one, two, one, two]) codes.push((await app.inject({ method: "GET", url: "/api/v1/ping", headers: auth })).statusCode);
      expect(codes).toEqual([200, 200, 200, 429]);
      const last = await one.inject({ method: "GET", url: "/api/v1/ping", headers: auth });
      expect(last.statusCode).toBe(429);
      expect(last.headers["retry-after"]).toBeDefined();
      // The public API is left to its own per-key limiter.
      expect(one.hasRoute({ method: "GET", url: "/api/v1/ping" })).toBe(true);
    } finally {
      await one.close();
      await two.close();
    }
  });
});
