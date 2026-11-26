import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createDb, maintainPublicApiTables, postCreditTransaction, schema } from "@skout/db";
import { registerPublicApiAuth } from "../plugins/public-api-auth.js";
import { createMemoryFailedAuthLimiter } from "../lib/failed-auth-limiter.js";
import { createMemoryQuotaStore } from "../lib/api-quota.js";
import { ApiPricingService } from "../services/api-pricing.service.js";
import { createPublicApiKey } from "../services/public-api-keys.service.js";
import { publicApiPlugin } from "./plugin.js";
import { createPublicIdCodec } from "./ids.js";
import { createRequestLogWriter } from "./request-log.js";
import type { PublicEndpoint } from "./pipeline.js";

/** PAPI-044 against a real, migrated Postgres: one api_request_log row per request, metadata only. */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const PEPPER = randomBytes(32).toString("base64");
const MARKER = `BODY-MARKER-${randomUUID().slice(0, 8)}`;

maybe("public API request log (PAPI-044)", () => {
  const { db, sql } = createDb(url as string);
  let app: FastifyInstance;
  let ws: string;
  let userId: string;
  let liveKey: string;
  let keyId: string;

  const lookup: PublicEndpoint = {
    method: "POST",
    path: "/dummy/lookup",
    scope: "people:read",
    operation: "people.lookup",
    input: z.object({ name: z.string().min(1).max(100) }).strict(),
    maxCost: (_i, prices) => prices["people.lookup"].credits,
    handle: async ({ input, prices }) => ({ data: { id: "per_x", greeting: `hi ${input.name}` }, charge: prices["people.lookup"].credits }),
    fixture: () => ({ id: "per_test" }),
  };
  const search: PublicEndpoint = {
    method: "POST",
    path: "/dummy/search",
    scope: "people:read",
    operation: "search.index_page",
    priceOperations: ["search.index_page", "search.vendor_result"],
    input: z.object({ q: z.string() }).strict(),
    maxCost: (_i, p) => p["search.index_page"].credits + 2 * p["search.vendor_result"].credits,
    handle: async ({ prices }) => ({ data: { results: [] }, charge: prices["search.index_page"].credits }),
    fixture: () => ({ results: [] }),
  };

  /** The log is written in onResponse, after the reply is sent, so wait briefly for the row. */
  const rowsFor = async (requestId: string) => {
    for (let i = 0; i < 40; i++) {
      const rows = await db.select().from(schema.apiRequestLog).where(eq(schema.apiRequestLog.requestId, requestId));
      if (rows.length > 0) {
        await new Promise((r) => setTimeout(r, 50)); // and make sure no second row follows
        return db.select().from(schema.apiRequestLog).where(eq(schema.apiRequestLog.requestId, requestId));
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    return [];
  };
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method: "POST",
      url: `/api/public/v1${path}`,
      headers: { authorization: `Bearer ${liveKey}`, "content-type": "application/json", "idempotency-key": randomUUID(), "user-agent": "log-test/1.0", ...headers },
      payload: JSON.stringify(body),
    });

  beforeAll(async () => {
    await maintainPublicApiTables(db); // make sure this month's partition exists
    ws = randomUUID();
    await db.insert(schema.workspaces).values({ id: ws, name: "PAPI-044", slug: `papi044-${ws}` });
    const [u] = await db.insert(schema.users).values({ email: `papi044-${ws.slice(0, 8)}@test.com` }).returning();
    userId = u!.id;
    await db.insert(schema.workspaceMembers).values({ workspaceId: ws, userId, role: "owner" });
    await db.insert(schema.workspaceApiSettings).values({ workspaceId: ws, addonEnabled: true });
    await db.insert(schema.entitlements).values({ workspaceId: ws, key: "api.price.people.lookup", value: 3, source: "test" });
    await postCreditTransaction(db, { workspaceId: ws, amount: 100, kind: "purchase", action: "test" });
    const k = await createPublicApiKey(db, { pepper: PEPPER, maxActiveKeys: 10 }, { workspaceId: ws, userId }, { name: "live", type: "live", scopes: ["people:read"] });
    liveKey = k.key;
    keyId = k.id;

    app = Fastify({ genReqId: () => randomUUID() }); // like the real app; the default counter repeats across runs
    app.decorate("config", { API_KEY_PEPPER: PEPPER, PUBLIC_API_MAX_ACTIVE_KEYS: 10 } as never);
    app.decorate("db", db);
    app.decorate("publicKeyCache", null);
    registerPublicApiAuth(app, { limiter: createMemoryFailedAuthLimiter({ perMinute: 1000, blockMinutes: 15 }) });
    await app.register(publicApiPlugin, {
      prefix: "/api/public/v1",
      deps: {
        db,
        pricing: new ApiPricingService(db, { INTERNAL_WORKSPACE_ID: randomUUID(), searchCreditCost: 1 }),
        quotas: createMemoryQuotaStore(),
        limitDefaults: { verifyDailyQuota: 5000, searchDailyQuota: 10000 },
        enabled: true,
        ids: createPublicIdCodec(PEPPER),
        logRequest: createRequestLogWriter(db),
      },
      scopeMap: { "POST /dummy/lookup": "people:read", "POST /dummy/search": "people:read" },
      endpoints: [lookup, search],
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, ws));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await sql.end();
  });

  it("writes exactly one row for a charged request, with the price it used and no body", async () => {
    const res = await post("/dummy/lookup", { name: MARKER });
    expect(res.statusCode).toBe(200);
    const rows = await rowsFor(String(res.headers["x-request-id"]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId: ws,
      apiKeyId: keyId,
      method: "POST",
      endpoint: "/dummy/lookup",
      statusCode: 200,
      errorCode: null,
      creditsCharged: 3,
      priceApplied: { "people.lookup": 3 },
      userAgent: "log-test/1.0",
    });
    expect(rows[0]!.latencyMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(rows[0])).not.toContain(MARKER);
  });

  it("records each price a multi-price endpoint used", async () => {
    const res = await post("/dummy/search", { q: MARKER });
    const [row] = await rowsFor(String(res.headers["x-request-id"]));
    expect(row!.priceApplied).toEqual({ "search.index_page": 1, "search.vendor_result": 1 });
  });

  it("logs rejected requests too: failed auth, bad input and unknown paths, without bodies, queries or ids", async () => {
    const noKey = await app.inject({ method: "POST", url: "/api/public/v1/dummy/lookup", headers: { "content-type": "application/json" }, payload: JSON.stringify({ name: MARKER }) });
    expect(noKey.statusCode).toBe(401);
    const [auth] = await rowsFor(String(noKey.headers["x-request-id"]));
    expect(auth).toMatchObject({ statusCode: 401, errorCode: "authentication_failed", workspaceId: null, apiKeyId: null, creditsCharged: 0 });

    const bad = await post("/dummy/lookup", { name: MARKER, extra: MARKER });
    const [invalid] = await rowsFor(String(bad.headers["x-request-id"]));
    expect(invalid).toMatchObject({ statusCode: 422, errorCode: "invalid_request", creditsCharged: 0, priceApplied: null });
    expect(JSON.stringify(invalid)).not.toContain(MARKER);

    const unknown = await app.inject({
      method: "GET",
      url: `/api/public/v1/people/per_${MARKER}?email=${MARKER}@example.com`,
      headers: { authorization: `Bearer ${liveKey}` },
    });
    expect(unknown.statusCode).toBe(404);
    const [nf] = await rowsFor(String(unknown.headers["x-request-id"]));
    expect(nf).toMatchObject({ statusCode: 404, errorCode: "not_found", endpoint: "unmatched", workspaceId: ws });
    expect(JSON.stringify(nf)).not.toContain(MARKER);
  });

  it("writes one row per request, replays included (charged 0)", async () => {
    const idem = { "idempotency-key": `log-${randomUUID()}` };
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(String((await post("/dummy/lookup", { name: "Ada" }, idem)).headers["x-request-id"]));
    expect(new Set(ids).size).toBe(3);
    const rows = (await Promise.all(ids.map(rowsFor))).map((r) => r);
    expect(rows.map((r) => r.length)).toEqual([1, 1, 1]);
    expect(rows.map((r) => r[0]!.creditsCharged)).toEqual([3, 0, 0]);
  });

  it("stores only metadata columns", async () => {
    const res = await post("/dummy/lookup", { name: "Ada" });
    const [row] = await rowsFor(String(res.headers["x-request-id"]));
    expect(Object.keys(row!).sort()).toEqual(
      ["apiKeyId", "createdAt", "creditsCharged", "endpoint", "errorCode", "id", "ip", "latencyMs", "method", "priceApplied", "requestId", "statusCode", "userAgent", "workspaceId"].sort()
    );
  });
});
