import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { createDb, postCreditTransaction, schema } from "@skout/db";
import { registerPublicApiAuth } from "../plugins/public-api-auth.js";
import { createMemoryFailedAuthLimiter } from "../lib/failed-auth-limiter.js";
import { createMemoryQuotaStore } from "../lib/api-quota.js";
import { ApiPricingService } from "../services/api-pricing.service.js";
import { createPublicApiKey } from "../services/public-api-keys.service.js";
import { availableCredits } from "../services/api-credits.service.js";
import { publicApiPlugin } from "./plugin.js";
import type { PublicApiDeps, PublicEndpoint, RequestLogEntry } from "./pipeline.js";
import { createRateLimitStep } from "./rate-limit-step.js";
import { claimIdempotencyKey, completeIdempotencyKey, requestHash } from "./idempotency.js";
import { createPublicIdCodec } from "./ids.js";
import { createMemoryRateLimiter } from "../lib/public-rate-limit.js";

/** PAPI-040: the public API plugin and its shared pipeline, with a dummy endpoint, on real Postgres. */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const PEPPER = randomBytes(32).toString("base64");

maybe("public API plugin skeleton (PAPI-040)", () => {
  const { db, sql } = createDb(url as string);
  let calls = 0;
  let rateOk = true;
  let logs: RequestLogEntry[] = [];
  let ws: string;
  let userId: string;
  let liveKey: string;
  let narrowKey: string;
  let testKey: string;
  const apps: FastifyInstance[] = [];

  const dummy: PublicEndpoint = {
    method: "POST",
    path: "/dummy/lookup",
    scope: "people:read",
    operation: "people.lookup",
    input: z
      .object({
        name: z.string().min(1).max(100),
        mode: z.enum(["found", "none", "throw", "slow"]).default("found"),
        results: z.number().int().min(0).max(25).default(3),
        blob: z.string().optional(),
      })
      .strict(),
    maxCost: (_i, prices) => prices["people.lookup"].credits,
    quota: { kind: "search_results", units: () => 25 },
    handle: async ({ input, prices }) => {
      calls++;
      if (input.mode === "throw") throw new Error("connect ECONNREFUSED db.internal:5432 password=hunter2");
      if (input.mode === "slow") await new Promise((r) => setTimeout(r, 2000));
      if (input.mode === "none") return { data: null, charge: 0, quotaUsed: 0 };
      return { data: { id: "per_123", name: input.name }, charge: prices["people.lookup"].credits, quotaUsed: input.results };
    },
    fixture: (input) => ({ id: "per_test_fixture", name: input.name }),
  };
  const leaky: PublicEndpoint = {
    method: "POST",
    path: "/dummy/leaky",
    scope: "people:read",
    operation: "people.lookup",
    input: z.object({ what: z.enum(["uuid", "provider"]) }).strict(),
    maxCost: (_i, prices) => prices["people.lookup"].credits,
    handle: async ({ input }) => {
      calls++;
      return { data: input.what === "uuid" ? { id: randomUUID() } : { id: "per_x", source: "Wiza" }, charge: 2 };
    },
    fixture: () => ({ id: "per_test" }),
  };
  const freeGet: PublicEndpoint = {
    method: "GET",
    path: "/dummy/free",
    scope: "any",
    operation: null,
    input: z.object({ q: z.string().max(10).optional() }).strict(),
    maxCost: () => 0,
    handle: async () => ({ data: { ok: true }, charge: 0 }),
    fixture: () => ({ ok: true }),
  };

  async function makeApp(enabled: boolean, rateLimit?: PublicApiDeps["rateLimit"]) {
    const app = Fastify();
    app.decorate("config", {
      API_KEY_PEPPER: PEPPER,
      PUBLIC_API_MAX_ACTIVE_KEYS: 10,
      PUBLIC_API_FAILED_AUTH_PER_MINUTE: 1000,
      PUBLIC_API_FAILED_AUTH_BLOCK_MINUTES: 15,
    } as never);
    app.decorate("db", db);
    app.decorate("publicKeyCache", null);
    registerPublicApiAuth(app, { limiter: createMemoryFailedAuthLimiter({ perMinute: 1000, blockMinutes: 15 }) });
    const deps: PublicApiDeps = {
      db,
      pricing: new ApiPricingService(db, { INTERNAL_WORKSPACE_ID: randomUUID(), searchCreditCost: 1 }),
      quotas: createMemoryQuotaStore(),
      limitDefaults: { verifyDailyQuota: 5000, searchDailyQuota: 10000 },
      enabled,
      ids: createPublicIdCodec(PEPPER),
      timeoutMs: 300,
      rateLimit: rateLimit ?? (async () => (rateOk ? { ok: true } : { ok: false, retryAfterSeconds: 7 })),
      logRequest: async (e) => void logs.push(e),
    };
    await app.register(publicApiPlugin, { prefix: "/api/public/v1", deps, endpoints: [dummy, freeGet, leaky] });
    await app.ready();
    apps.push(app);
    return app;
  }

  let app: FastifyInstance;
  const call = (key: string | null, body: unknown, headers: Record<string, string> = {}, path = "/api/public/v1/dummy/lookup", target = app) =>
    target.inject({
      method: "POST",
      url: path,
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json", "idempotency-key": randomUUID(), ...headers },
      payload: typeof body === "string" ? body : JSON.stringify(body),
    });
  const ledger = () =>
    db.select().from(schema.creditTransactions).where(and(eq(schema.creditTransactions.workspaceId, ws), eq(schema.creditTransactions.kind, "consume")));
  const activeHolds = async () =>
    (await db.select().from(schema.creditHolds).where(and(eq(schema.creditHolds.workspaceId, ws), eq(schema.creditHolds.status, "held")))).length;

  beforeAll(async () => {
    ws = randomUUID();
    await db.insert(schema.workspaces).values({ id: ws, name: "PAPI-040", slug: `papi040-${ws}` });
    const [u] = await db.insert(schema.users).values({ email: `papi040-${ws.slice(0, 8)}@test.com` }).returning();
    userId = u!.id;
    await db.insert(schema.workspaceMembers).values({ workspaceId: ws, userId, role: "owner" });
    await db.insert(schema.workspaceApiSettings).values({ workspaceId: ws, addonEnabled: true, searchDailyQuota: 40 });
    await db.insert(schema.entitlements).values({ workspaceId: ws, key: "api.price.people.lookup", value: 2, source: "test" });
    await postCreditTransaction(db, { workspaceId: ws, amount: 100, kind: "purchase", action: "test" });
    const cfg = { pepper: PEPPER, maxActiveKeys: 10 };
    const actor = { workspaceId: ws, userId };
    liveKey = (await createPublicApiKey(db, cfg, actor, { name: "live", type: "live", scopes: ["people:read"] })).key;
    narrowKey = (await createPublicApiKey(db, cfg, actor, { name: "narrow", type: "live", scopes: ["search:read"] })).key;
    testKey = (await createPublicApiKey(db, cfg, actor, { name: "test", type: "test", scopes: ["people:read"] })).key;
    app = await makeApp(true);
  });

  beforeEach(() => {
    calls = 0;
    rateOk = true;
    logs = [];
  });

  afterAll(async () => {
    for (const a of apps) await a.close();
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, ws));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await sql.end();
  });

  it("runs the whole pipeline for a live key: charge, credit and security headers, ledger row, log entry", async () => {
    const res = await call(liveKey, { name: "Ada" }, { origin: "https://evil.example" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: { id: "per_123", name: "Ada" } });
    expect(res.headers).toMatchObject({
      "x-credits-charged": "2",
      "x-credits-remaining": "98",
      "x-request-id": expect.any(String),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "strict-transport-security": expect.stringContaining("max-age="),
    });
    expect(Object.keys(res.headers).filter((h) => h.startsWith("access-control-"))).toEqual([]);
    expect((await ledger()).map((r) => [r.action, r.amount, r.category])).toEqual([["api.people.lookup", -2, "data"]]);
    expect(await activeHolds()).toBe(0);
    expect(logs).toEqual([
      expect.objectContaining({ endpoint: "/dummy/lookup", statusCode: 200, creditsCharged: 2, errorCode: null, workspaceId: ws, priceApplied: expect.objectContaining({ "people.lookup": 2 }) }),
    ]);
  });

  it("rejects a key without the endpoint's scope before the handler runs", async () => {
    const res = await call(narrowKey, { name: "Ada" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatchObject({ type: "permission_error", code: "scope_missing", request_id: expect.any(String), doc_url: expect.stringContaining("#scope_missing") });
    expect(calls).toBe(0);
    expect(logs[0]).toMatchObject({ statusCode: 403, errorCode: "scope_missing", creditsCharged: 0 });
  });

  it("applies the rate limit step with Retry-After", async () => {
    rateOk = false;
    const res = await call(liveKey, { name: "Ada" });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("rate_limited");
    expect(res.headers["retry-after"]).toBe("7");
    expect(calls).toBe(0);
  });

  it("validates strictly: unknown fields, workspace_id, bad JSON and bodies over 1 MB", async () => {
    for (const body of [{ name: "Ada", extra: 1 }, { name: "" }, { name: "Ada", workspace_id: randomUUID() }, "{not json"]) {
      const res = await call(liveKey, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(422);
      expect(res.json().error.code).toBe("invalid_request");
    }
    const big = await call(liveKey, { name: "Ada", blob: "x".repeat(1_100_000) });
    expect(big.statusCode).toBe(413);
    expect(big.json().error.code).toBe("invalid_request");
    const query = await app.inject({ method: "GET", url: "/api/public/v1/dummy/free?q=1&unknown=2", headers: { authorization: `Bearer ${liveKey}` } });
    expect(query.statusCode).toBe(422);
    expect(calls).toBe(0);
  });

  it("takes the daily quota up front, gives back unused units, and refuses past it", async () => {
    const other = await createPublicApiKey(db, { pepper: PEPPER, maxActiveKeys: 10 }, { workspaceId: ws, userId }, { name: "q", type: "live", scopes: ["people:read"] });
    expect((await call(other.key, { name: "a", results: 10 })).statusCode).toBe(200); // used 10 of 40
    expect((await call(other.key, { name: "b", results: 3 })).statusCode).toBe(200); // used 13
    const res = await call(other.key, { name: "c" }); // 13 used + 25 up front = 38 <= 40: ok, then back to 16
    expect(res.statusCode).toBe(200);
    const over = await call(other.key, { name: "d" }); // 16 used + 25 = 41 > 40
    expect(over.statusCode).toBe(429);
    expect(over.json().error).toMatchObject({ code: "quota_reached", type: "rate_limit_error" });
  });

  it("refuses before any work when credits can't cover the reservation", async () => {
    const poor = randomUUID();
    await db.insert(schema.workspaces).values({ id: poor, name: "Poor", slug: `papi040p-${poor}` });
    await db.insert(schema.workspaceMembers).values({ workspaceId: poor, userId, role: "owner" });
    await db.insert(schema.workspaceApiSettings).values({ workspaceId: poor, addonEnabled: true });
    await postCreditTransaction(db, { workspaceId: poor, amount: 0 + 1, kind: "purchase", action: "test" });
    await db.insert(schema.entitlements).values({ workspaceId: poor, key: "api.price.people.lookup", value: 5, source: "test" });
    const k = await createPublicApiKey(db, { pepper: PEPPER, maxActiveKeys: 10 }, { workspaceId: poor, userId }, { name: "p", type: "live", scopes: ["people:read"] });
    const res = await call(k.key, { name: "Ada" });
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toMatchObject({ code: "insufficient_credits", type: "billing_error" });
    expect(res.headers["x-credits-charged"]).toBe("0");
    expect(res.headers["x-credits-remaining"]).toBe("1");
    expect(calls).toBe(0);
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, poor));
  });

  it("charges nothing for no result, and releases the hold", async () => {
    const before = (await ledger()).length;
    const res = await call(liveKey, { name: "Nobody", mode: "none" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: null });
    expect(res.headers["x-credits-charged"]).toBe("0");
    expect((await ledger()).length).toBe(before);
    expect(await activeHolds()).toBe(0);
  });

  it("returns internal_error with no stack or internals when the handler throws, and charges nothing", async () => {
    const before = (await availableCredits(db, ws)).balance;
    const res = await call(liveKey, { name: "Ada", mode: "throw" });
    expect(res.statusCode).toBe(500);
    const text = res.body;
    expect(res.json()).toEqual({
      error: {
        type: "api_error",
        code: "internal_error",
        message: expect.any(String),
        request_id: res.headers["x-request-id"],
        doc_url: expect.stringContaining("#internal_error"),
      },
    });
    for (const leak of ["ECONNREFUSED", "hunter2", "db.internal", "stack", "at ", ".ts:"]) expect(text).not.toContain(leak);
    expect((await availableCredits(db, ws)).balance).toBe(before);
    expect(await activeHolds()).toBe(0);
    expect(logs[0]).toMatchObject({ statusCode: 500, errorCode: "internal_error", creditsCharged: 0 });
  });

  it("stops a request at the time limit with upstream_unavailable and releases the hold", async () => {
    const started = Date.now();
    const res = await call(liveKey, { name: "Ada", mode: "slow" });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("upstream_unavailable");
    expect(await activeHolds()).toBe(0);
  });

  it("serves test keys fixture data without touching the wallet or the quota", async () => {
    const before = (await availableCredits(db, ws)).balance;
    const res = await call(testKey, { name: "Ada" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: { id: "per_test_fixture", name: "Ada" } });
    expect(res.headers["x-credits-charged"]).toBe("0");
    expect(calls).toBe(0);
    expect((await availableCredits(db, ws)).balance).toBe(before);
  });

  it("replays a retried request with the same Idempotency-Key and charges nothing new (PAPI-042)", async () => {
    const idem = { "idempotency-key": `retry-${randomUUID()}` };
    const first = await call(liveKey, { name: "Grace", results: 2 }, idem);
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-credits-charged"]).toBe("2");
    const chargesBefore = (await ledger()).length;
    const balance = (await availableCredits(db, ws)).balance;

    // Same key, same body (keys in another order): the original response, free, handler not run again.
    const again = await call(liveKey, { results: 2, name: "Grace" }, idem);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.headers["x-credits-charged"]).toBe("0");
    expect(again.headers["x-credits-remaining"]).toBe(String(balance));
    expect(calls).toBe(1);
    expect((await ledger()).length).toBe(chargesBefore);
  });

  it("refuses the same Idempotency-Key with a different body (409), and a missing or bad header (422)", async () => {
    const idem = { "idempotency-key": `conflict-${randomUUID()}` };
    expect((await call(liveKey, { name: "Ada" }, idem)).statusCode).toBe(200);
    const conflict = await call(liveKey, { name: "Bob" }, idem);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toMatchObject({ code: "idempotency_conflict", type: "invalid_request_error" });

    const missing = await app.inject({
      method: "POST",
      url: "/api/public/v1/dummy/lookup",
      headers: { authorization: `Bearer ${liveKey}`, "content-type": "application/json" },
      payload: JSON.stringify({ name: "Ada" }),
    });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().error.message).toContain("Idempotency-Key");
    expect((await call(liveKey, { name: "Ada" }, { "idempotency-key": "x".repeat(256) })).statusCode).toBe(422);
    expect(calls).toBe(1);
  });

  it("lets a failed request be retried with the same key, and keeps keys per workspace", async () => {
    const idem = { "idempotency-key": `fail-${randomUUID()}` };
    expect((await call(liveKey, { name: "Ada", mode: "throw" }, idem)).statusCode).toBe(500);
    const retry = await call(liveKey, { name: "Ada" }, idem);
    expect(retry.statusCode).toBe(200);
    expect(retry.headers["idempotent-replayed"]).toBeUndefined();
    // The same key string from another workspace is a different key.
    const [row] = await db.select().from(schema.apiIdempotency).where(eq(schema.apiIdempotency.key, idem["idempotency-key"]));
    expect(row).toMatchObject({ workspaceId: ws, statusCode: 200 });
  });

  it("answers 409 while the first request with a key is still running, and forgets keys after 24 hours", async () => {
    const key = `window-${randomUUID()}`;
    const hash = requestHash("POST", "/dummy/lookup", { name: "Ada" });
    const t0 = new Date();
    expect(await claimIdempotencyKey(db, { workspaceId: ws, header: key, hash }, t0)).toEqual({ kind: "new", key });
    await expect(claimIdempotencyKey(db, { workspaceId: ws, header: key, hash }, t0)).rejects.toMatchObject({ code: "idempotency_conflict" });
    await completeIdempotencyKey(db, ws, key, 200, { data: 1 });
    expect(await claimIdempotencyKey(db, { workspaceId: ws, header: key, hash }, t0)).toMatchObject({ kind: "replay", status: 200, body: { data: 1 } });
    // 24 hours later the key is free again, even for a different request.
    const other = requestHash("POST", "/dummy/lookup", { name: "Bob" });
    expect(await claimIdempotencyKey(db, { workspaceId: ws, header: key, hash: other }, new Date(t0.getTime() + 24 * 3_600_000 + 1000))).toEqual({ kind: "new", key });
  });

  it("doesn't need an Idempotency-Key on free GET endpoints", async () => {
    const res = await app.inject({ method: "GET", url: "/api/public/v1/dummy/free", headers: { authorization: `Bearer ${liveKey}` } });
    expect(res.statusCode).toBe(200);
  });

  it("sets RateLimit-* headers on every call and Retry-After once a key is over its limit (PAPI-041)", async () => {
    const limited = await makeApp(true, createRateLimitStep({ limiter: createMemoryRateLimiter(), base: { perSecond: 100, perMinute: 3, batchPerMinute: 1 }, db }));
    const get = () => limited.inject({ method: "GET", url: "/api/public/v1/dummy/free", headers: { authorization: `Bearer ${liveKey}` } });
    const seen = [];
    for (let i = 0; i < 3; i++) {
      const r = await get();
      expect(r.statusCode).toBe(200);
      seen.push(r.headers["ratelimit-remaining"]);
      expect(r.headers["ratelimit-limit"]).toBe("3");
      expect(Number(r.headers["ratelimit-reset"])).toBeGreaterThan(0);
    }
    expect(seen).toEqual(["2", "1", "0"]);
    const over = await get();
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe("rate_limited");
    expect(Number(over.headers["retry-after"])).toBeGreaterThan(0);
    expect(over.headers["ratelimit-remaining"]).toBe("0");
    expect(over.headers["x-credits-charged"]).toBe("0");
  });

  it("never returns an internal UUID or a provider name: such a response becomes internal_error and charges nothing (PAPI-043)", async () => {
    const before = (await availableCredits(db, ws)).balance;
    for (const what of ["uuid", "provider"]) {
      const res = await call(liveKey, { what }, {}, "/api/public/v1/dummy/leaky");
      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe("internal_error");
      expect(res.body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      expect(res.body.toLowerCase()).not.toContain("wiza");
    }
    expect((await availableCredits(db, ws)).balance).toBe(before);
    expect(await activeHolds()).toBe(0);
  });

  it("keeps UUIDs and provider names out of every response body, success or error", async () => {
    const responses = [
      await call(liveKey, { name: "Ada" }),
      await call(liveKey, { name: "Ada", mode: "none" }),
      await call(liveKey, { name: "Ada", mode: "throw" }),
      await call(narrowKey, { name: "Ada" }),
      await call(null, { name: "Ada" }),
      await call(liveKey, { name: "Ada", extra: 1 }),
      await call(testKey, { name: "Ada" }),
      await app.inject({ method: "GET", url: "/api/public/v1/nope", headers: { authorization: `Bearer ${liveKey}` } }),
      await app.inject({ method: "GET", url: "/api/public/v1/health" }),
    ];
    for (const res of responses) {
      expect(res.body, res.body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      for (const name of ["wiza", "contactout", "datagma", "unipile"]) expect(res.body.toLowerCase()).not.toContain(name);
      expect(String(res.headers["x-request-id"] ?? "req_")).toMatch(/^req_/);
    }
  });

  it("answers unknown paths with not_found, and only the health check while the flag is off", async () => {
    const unknown = await app.inject({ method: "GET", url: "/api/public/v1/nope", headers: { authorization: `Bearer ${liveKey}` } });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toMatchObject({ code: "not_found", type: "invalid_request_error" });

    const off = await makeApp(false);
    const res = await call(liveKey, { name: "Ada" }, {}, "/api/public/v1/dummy/lookup", off);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
    expect(calls).toBe(0);
    expect((await off.inject({ method: "GET", url: "/api/public/v1/health" })).statusCode).toBe(200);
  });
});
