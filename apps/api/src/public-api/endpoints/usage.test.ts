import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb, postCreditTransaction, schema } from "@skout/db";
import { registerPublicApiAuth } from "../../plugins/public-api-auth.js";
import { createMemoryFailedAuthLimiter } from "../../lib/failed-auth-limiter.js";
import { createMemoryQuotaStore } from "../../lib/api-quota.js";
import { ApiPricingService } from "../../services/api-pricing.service.js";
import { createPublicApiKey } from "../../services/public-api-keys.service.js";
import { reserve } from "../../services/api-credits.service.js";
import { publicApiPlugin } from "../plugin.js";
import { createPublicIdCodec } from "../ids.js";
import { createUsageEndpoint } from "./usage.js";

/** PAPI-061: GET /usage on real Postgres. */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const PEPPER = randomBytes(32).toString("base64");
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

maybe("usage endpoint (PAPI-061)", () => {
  const { db, sql } = createDb(url as string);
  let app: FastifyInstance;
  const quotas = createMemoryQuotaStore();
  let ws = "";
  let userId = "";
  const keys = { usage: { id: "", key: "" }, other: { id: "", key: "" }, narrow: "", test: "" };

  beforeAll(async () => {
    ws = randomUUID();
    await db.insert(schema.workspaces).values({ id: ws, name: "PAPI-061", slug: `papi061-${ws}` });
    const [u] = await db.insert(schema.users).values({ email: `papi061-${ws.slice(0, 8)}@test.com`, isActive: true }).returning();
    userId = u!.id;
    await db.insert(schema.workspaceMembers).values({ workspaceId: ws, userId, role: "owner" });
    // Workspace settings: a monthly API cap and a lower verification quota.
    await db.insert(schema.workspaceApiSettings).values({ workspaceId: ws, addonEnabled: true, monthlyCreditCap: 300, verifyDailyQuota: 50 });
    await db.insert(schema.entitlements).values({ workspaceId: ws, key: "api.price.people.lookup", value: 3, source: "test" });
    await postCreditTransaction(db, { workspaceId: ws, amount: 100, kind: "purchase", action: "test" });
    const mk = (name: string, scopes: string[], caps: { dailyCreditCap?: number; monthlyCreditCap?: number } = {}, type: "live" | "test" = "live") =>
      createPublicApiKey(db, { pepper: PEPPER, maxActiveKeys: 10 }, { workspaceId: ws, userId }, { name, type, scopes, ...caps });
    const usage = await mk("usage", ["usage:read"], { dailyCreditCap: 20, monthlyCreditCap: 200 });
    const other = await mk("other", ["people:read"]);
    keys.usage = { id: usage.id, key: usage.key };
    keys.other = { id: other.id, key: other.key };
    keys.narrow = other.key;
    keys.test = (await mk("test", ["usage:read"], {}, "test")).key;

    // API spend: 5 by this key, 7 by another key; 9 spent in the app (not API spend).
    await postCreditTransaction(db, { workspaceId: ws, amount: -5, kind: "consume", action: "api.people.lookup", apiKeyId: usage.id });
    await postCreditTransaction(db, { workspaceId: ws, amount: -7, kind: "consume", action: "api.people.lookup", apiKeyId: other.id });
    await postCreditTransaction(db, { workspaceId: ws, amount: -9, kind: "consume", action: "enrichment" });
    // 4 credits held for this key's in-flight request.
    await reserve(db, { workspaceId: ws, apiKeyId: usage.id, requestId: `req-${randomUUID()}`, max: 4 });
    await quotas.tryConsume("verify", usage.id, 12, 50);
    await quotas.tryConsume("search_results", usage.id, 25, 10000);

    app = Fastify({ genReqId: () => randomUUID() });
    app.decorate("config", { API_KEY_PEPPER: PEPPER, PUBLIC_API_MAX_ACTIVE_KEYS: 10 } as never);
    app.decorate("db", db);
    app.decorate("publicKeyCache", null);
    registerPublicApiAuth(app, { limiter: createMemoryFailedAuthLimiter({ perMinute: 1000, blockMinutes: 15 }) });
    await app.register(publicApiPlugin, {
      prefix: "/api/public/v1",
      deps: {
        db,
        pricing: new ApiPricingService(db, { INTERNAL_WORKSPACE_ID: randomUUID(), searchCreditCost: 1 }),
        quotas,
        limitDefaults: { verifyDailyQuota: 5000, searchDailyQuota: 10000 },
        enabled: true,
        ids: createPublicIdCodec(PEPPER),
      },
      endpoints: [createUsageEndpoint({ env: {} as never, db }) as never],
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, ws));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await sql.end();
  });

  const get = (key: string, qs = "") => app.inject({ method: "GET", url: `/api/public/v1/usage${qs}`, headers: { authorization: `Bearer ${key}` } });

  it("shows balance, API spend, caps and quotas left, and this workspace's prices, for free", async () => {
    const res = await get(keys.usage.key);
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.credits).toEqual({ balance: 79, held: 4, available: 75 });
    expect(d.spent).toEqual({ key_today: 5, key_this_month: 5, workspace_api_today: 12, workspace_api_this_month: 12 });
    // Caps count held credits too.
    expect(d.caps.key_daily).toMatchObject({ limit: 20, used: 9, remaining: 11 });
    expect(d.caps.key_monthly).toMatchObject({ limit: 200, used: 9, remaining: 191 });
    expect(d.caps.workspace_monthly).toMatchObject({ limit: 300, used: 16, remaining: 284 });
    expect(Date.parse(d.caps.key_daily.resets_at) % 86_400_000).toBe(0);
    expect(d.quotas.email_verifications_daily).toMatchObject({ limit: 50, used: 12, remaining: 38 });
    expect(d.quotas.search_results_daily).toMatchObject({ limit: 10000, used: 25, remaining: 9975 });
    expect(d.prices["people.lookup"]).toBe(3);
    expect(d.prices["emails.verify"]).toBe(0);
    expect(Object.keys(d.prices)).toContain("contacts.phone_find");
    expect(res.headers["x-credits-charged"]).toBe("0");
    expect(res.body).not.toMatch(UUID_RE);
  });

  it("needs usage:read, rejects query params, and serves test keys a fixture", async () => {
    expect((await get(keys.narrow)).statusCode).toBe(403);
    expect((await get(keys.usage.key, "?workspace_id=x")).statusCode).toBe(422);
    const fx = await get(keys.test);
    expect(fx.statusCode).toBe(200);
    expect(fx.json().data.credits.balance).toBe(1000);
  });
});
