import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { ipAllowed, registerPublicApiAuth } from "./public-api-auth.js";
import { createMemoryFailedAuthLimiter, createRedisFailedAuthLimiter } from "../lib/failed-auth-limiter.js";
import { createPublicApiKey, generatePublicApiKey, revokePublicApiKey } from "../services/public-api-keys.service.js";
import { generateApiKey } from "../services/cops-api-credentials.service.js";

const PEPPER = randomBytes(32).toString("base64");

describe("IP allowlist matching (KEY-6)", () => {
  it("matches addresses and CIDR blocks for IPv4 and IPv6, and allows any IP when empty", () => {
    expect(ipAllowed("203.0.113.7", [])).toBe(true);
    expect(ipAllowed("203.0.113.7", ["203.0.113.0/24"])).toBe(true);
    expect(ipAllowed("::ffff:203.0.113.7", ["203.0.113.0/24"])).toBe(true);
    expect(ipAllowed("198.51.100.1", ["203.0.113.0/24", "10.0.0.1"])).toBe(false);
    expect(ipAllowed("10.0.0.1", ["203.0.113.0/24", "10.0.0.1"])).toBe(true);
    expect(ipAllowed("2001:db8::5", ["2001:db8::/32"])).toBe(true);
    expect(ipAllowed("2001:db9::5", ["2001:db8::/32"])).toBe(false);
    expect(ipAllowed("not-an-ip", ["0.0.0.0/0"])).toBe(false);
  });
});

const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("a public key gets 401 on every internal route (PAPI-024, PRD §9.1)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const config = loadEnv();
    app = await buildApp({ ...config, CLERK_SECRET_KEY: undefined, LOG_LEVEL: "fatal", OPENSEARCH_URL: undefined, RATE_LIMIT_MAX: 1_000_000, API_KEY_PEPPER: PEPPER });
  }, 60000);
  afterAll(async () => {
    await app?.close();
  });

  it("checks the full route table", async () => {
    const key = generatePublicApiKey("live", PEPPER).key;
    const routes = app.routeTable().filter((r) => !r.url.startsWith("/api/public"));
    expect(routes.length).toBeGreaterThan(100);
    const failures: string[] = [];
    let checked = 0;
    for (const route of routes) {
      const path = route.url.replace(/:[^/]+/g, randomUUID()).replace(/\*/g, "x");
      for (const method of route.methods) {
        const res = await app.inject({
          method: method as "GET",
          url: path,
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json", origin: "https://www.skoutai.io" },
          payload: method === "GET" || method === "HEAD" || method === "OPTIONS" ? undefined : "{}",
        });
        checked++;
        if (res.statusCode !== 401) failures.push(`${method} ${route.url} -> ${res.statusCode}`);
      }
    }
    expect(failures).toEqual([]);
    expect(checked).toBeGreaterThan(100);
  }, 300000);

  it("still serves the unauthenticated public health check", async () => {
    const res = await app.inject({ method: "GET", url: "/api/public/v1/health" });
    expect(res.statusCode).toBe(200);
  });
});

maybe("public prefix authentication (PAPI-024)", () => {
  const { db, sql } = createDb(url as string);
  let app: FastifyInstance;
  let ws: string;
  let userId: string;
  const actor = () => ({ workspaceId: ws, userId });
  const cfg = { pepper: PEPPER, maxActiveKeys: 10 };
  const newKey = (over: Record<string, unknown> = {}) =>
    createPublicApiKey(db, cfg, actor(), { name: "k", type: "live", scopes: ["search:read"], ...over });
  const call = (headers: Record<string, string> = {}, path = "/api/public/v1/echo", remoteAddress = "203.0.113.7") =>
    app.inject({ method: "GET", url: path, headers, remoteAddress });

  beforeAll(async () => {
    ws = randomUUID();
    await db.insert(schema.workspaces).values({ id: ws, name: "PAPI-024", slug: `papi024-${ws}` });
    const [u] = await db.insert(schema.users).values({ email: `papi024-${ws.slice(0, 8)}@test.com`, isActive: true }).returning();
    userId = u!.id;
    await db.insert(schema.workspaceMembers).values({ workspaceId: ws, userId, role: "owner" });
    await db.insert(schema.workspaceApiSettings).values({ workspaceId: ws, addonEnabled: true });

    app = Fastify();
    app.decorate("config", { API_KEY_PEPPER: PEPPER, PUBLIC_API_MAX_ACTIVE_KEYS: 10 } as never);
    app.decorate("db", db);
    app.decorate("publicKeyCache", null);
    registerPublicApiAuth(app);
    app.get("/api/public/v1/echo", async (req) => ({ key: req.publicApiKey, workspace: req.workspaceId }));
    app.get("/api/public/v1/health", async () => ({ ok: true }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, ws));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await sql.end();
  });

  it("accepts a valid key, takes the workspace from it, and records last use", async () => {
    const k = await newKey();
    const res = await call({ authorization: `Bearer ${k.key}` }, `/api/public/v1/echo?workspace_id=${randomUUID()}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ workspace: ws, key: { id: k.id, workspaceId: ws, type: "live", scopes: ["search:read"] } });
    await new Promise((r) => setTimeout(r, 200));
    const [row] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, k.id));
    expect(row!.lastUsedAt).not.toBeNull();
    expect(row!.lastUsedIp).toBe("203.0.113.7");
  });

  it("refuses anything but a public key in the Authorization header, in the CONV-6 error shape", async () => {
    const k = await newKey();
    const cases: Record<string, string>[] = [
      {},
      { authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.e30.sig" },
      { authorization: `Bearer ${generateApiKey().key}` },
      { cookie: "__session=abc; skout_rt=xyz" },
      { authorization: `Bearer ${generatePublicApiKey("live", PEPPER).key}` },
    ];
    for (const headers of cases) {
      const res = await call(headers);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({
        error: { type: "authentication_error", code: "authentication_failed", request_id: expect.any(String), doc_url: expect.stringContaining("#authentication_failed") },
      });
    }
    const inQuery = await call({}, `/api/public/v1/echo?api_key=${encodeURIComponent(k.key)}`);
    expect(inQuery.statusCode).toBe(401);
    expect(inQuery.json().error.message).toContain("Authorization header");
  });

  it("reports revoked and expired keys", async () => {
    const revoked = await newKey();
    await revokePublicApiKey(db, actor(), revoked.id, "test");
    expect((await call({ authorization: `Bearer ${revoked.key}` })).json().error.code).toBe("key_revoked");

    const old = await createPublicApiKey(db, cfg, actor(), { name: "old", type: "live", scopes: ["search:read"], expiresInDays: 1 }, new Date(Date.now() - 2 * 86_400_000));
    const res = await call({ authorization: `Bearer ${old.key}` });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("key_expired");
  });

  it("enforces the key's IP allowlist", async () => {
    const k = await newKey({ ipAllowlist: ["198.51.100.0/24"] });
    const denied = await call({ authorization: `Bearer ${k.key}` });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("ip_not_allowed");
    expect((await call({ authorization: `Bearer ${k.key}` }, undefined, "198.51.100.20")).statusCode).toBe(200);
  });

  it("refuses every key once the add-on is off, and while the workspace is suspended", async () => {
    const k = await newKey();
    await db.update(schema.workspaceApiSettings).set({ addonEnabled: false }).where(eq(schema.workspaceApiSettings.workspaceId, ws));
    const off = await call({ authorization: `Bearer ${k.key}` });
    expect(off.statusCode).toBe(403);
    expect(off.json().error.code).toBe("addon_disabled");
    await db.update(schema.workspaceApiSettings).set({ addonEnabled: true }).where(eq(schema.workspaceApiSettings.workspaceId, ws));

    await db.insert(schema.entitlements).values({ workspaceId: ws, key: "subscription", value: { status: "suspended" }, source: "test" });
    const suspended = await call({ authorization: `Bearer ${k.key}` });
    expect(suspended.statusCode).toBe(403);
    expect(suspended.json().error.code).toBe("workspace_suspended");
    await db.delete(schema.entitlements).where(and(eq(schema.entitlements.workspaceId, ws), eq(schema.entitlements.key, "subscription")));
    expect((await call({ authorization: `Bearer ${k.key}` })).statusCode).toBe(200);
  });

  it("stops a key once its creator leaves the workspace (KEY-11)", async () => {
    const k = await newKey();
    await db.delete(schema.workspaceMembers).where(and(eq(schema.workspaceMembers.workspaceId, ws), eq(schema.workspaceMembers.userId, userId)));
    const res = await call({ authorization: `Bearer ${k.key}` });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("key_revoked");
    await db.insert(schema.workspaceMembers).values({ workspaceId: ws, userId, role: "owner" });
  });

  it("lets the health check through without a key", async () => {
    expect((await call({}, "/api/public/v1/health")).statusCode).toBe(200);
  });
});

maybe("failed-authentication limit per IP (PAPI-025, RL-3)", () => {
  const { db, sql } = createDb(url as string);
  let now = Date.now();
  const limiter = createMemoryFailedAuthLimiter({ perMinute: 20, blockMinutes: 15 }, () => now);
  let app: FastifyInstance;
  let ws: string;
  let userId: string;
  let validKey: string;
  const ATTACKER = "198.51.100.66";
  const OTHER = "198.51.100.77";
  const call = (ip: string, authorization?: string, path = "/api/public/v1/echo") =>
    app.inject({ method: "GET", url: path, remoteAddress: ip, headers: authorization ? { authorization } : {} });

  beforeAll(async () => {
    ws = randomUUID();
    await db.insert(schema.workspaces).values({ id: ws, name: "PAPI-025", slug: `papi025-${ws}` });
    const [u] = await db.insert(schema.users).values({ email: `papi025-${ws.slice(0, 8)}@test.com`, isActive: true }).returning();
    userId = u!.id;
    await db.insert(schema.workspaceMembers).values({ workspaceId: ws, userId, role: "owner" });
    await db.insert(schema.workspaceApiSettings).values({ workspaceId: ws, addonEnabled: true });
    validKey = (await createPublicApiKey(db, { pepper: PEPPER, maxActiveKeys: 10 }, { workspaceId: ws, userId }, { name: "k", type: "live", scopes: ["search:read"] })).key;

    app = Fastify();
    app.decorate("config", { API_KEY_PEPPER: PEPPER, PUBLIC_API_MAX_ACTIVE_KEYS: 10 } as never);
    app.decorate("db", db);
    app.decorate("publicKeyCache", null);
    registerPublicApiAuth(app, { limiter });
    app.get("/api/public/v1/echo", async (req) => ({ workspace: req.workspaceId }));
    app.get("/", async () => "website");
    app.get("/api/v1/me", async () => ({ ok: true }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, ws));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await sql.end();
  });

  it("blocks the 21st bad key from one IP with 429, keeps other IPs working, and leaves the website alone", async () => {
    for (let i = 1; i <= 20; i++) {
      const res = await call(ATTACKER, `Bearer ${generatePublicApiKey("live", PEPPER).key}`);
      expect(res.statusCode, `attempt ${i}`).toBe(401);
    }
    const blocked = await call(ATTACKER, `Bearer ${generatePublicApiKey("live", PEPPER).key}`);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe("rate_limited");
    expect(Number(blocked.headers["retry-after"])).toBe(900);
    // Even a valid key from the blocked IP waits out the block.
    expect((await call(ATTACKER, `Bearer ${validKey}`)).statusCode).toBe(429);
    // A valid key from another IP still works.
    expect((await call(OTHER, `Bearer ${validKey}`)).statusCode).toBe(200);
    // The blocked IP can still load the website and the app.
    expect((await call(ATTACKER, undefined, "/")).statusCode).toBe(200);
    expect((await call(ATTACKER, undefined, "/api/v1/me")).statusCode).toBe(200);
  });

  it("lifts the block after 15 minutes, and successful calls never count", async () => {
    now += 14 * 60_000;
    expect((await call(ATTACKER, `Bearer ${validKey}`)).statusCode).toBe(429);
    now += 61_000;
    expect((await call(ATTACKER, `Bearer ${validKey}`)).statusCode).toBe(200);
    for (let i = 0; i < 50; i++) expect((await call(OTHER, `Bearer ${validKey}`)).statusCode).toBe(200);
  });

  it("forgets failures older than a minute", async () => {
    const ip = "198.51.100.88";
    for (let i = 0; i < 19; i++) await call(ip, "Bearer nope");
    now += 61_000;
    for (let i = 0; i < 19; i++) expect((await call(ip, "Bearer nope")).statusCode).toBe(401);
    expect((await call(ip, `Bearer ${validKey}`)).statusCode).toBe(200);
  });
});

describe("Redis failed-auth limiter (shared across instances)", async () => {
  const { Redis } = await import("ioredis");
  const redisUrl = process.env.PAPI_TEST_REDIS_URL ?? "redis://127.0.0.1:6379";
  const probe = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 0, connectTimeout: 500, retryStrategy: () => null });
  probe.on("error", () => undefined);
  const up = await probe.connect().then(() => true, () => false);
  const run = up ? it : it.skip;

  afterAll(async () => {
    probe.disconnect();
  });

  run("two instances share one counter: 20 failures across them block the IP on both", async () => {
    const ip = `192.0.2.${Math.floor(Math.random() * 200) + 1}-${randomUUID().slice(0, 4)}`;
    const a = createRedisFailedAuthLimiter(probe, { perMinute: 20, blockMinutes: 15 });
    const b = createRedisFailedAuthLimiter(probe, { perMinute: 20, blockMinutes: 15 });
    for (let i = 0; i < 10; i++) await a.recordFailure(ip);
    for (let i = 0; i < 9; i++) await b.recordFailure(ip);
    expect(await a.blockedFor(ip)).toBe(0);
    await b.recordFailure(ip);
    expect(await a.blockedFor(ip)).toBeGreaterThan(890);
    expect(await b.blockedFor(ip)).toBeGreaterThan(890);
    await probe.del(`papi:authblock:${ip}`);
  });
});
