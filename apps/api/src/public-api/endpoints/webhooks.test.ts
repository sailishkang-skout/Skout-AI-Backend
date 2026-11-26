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
import { publicApiPlugin } from "../plugin.js";
import { createPublicIdCodec } from "../ids.js";
import { notifyJobFinished } from "../jobs.js";
import { MAX_API_WEBHOOKS, createCreateWebhookEndpoint, createDeleteWebhookEndpoint, createListWebhooksEndpoint } from "./webhooks.js";

/** PAPI-062: /webhooks on real Postgres, and the api.job.* events. */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const PEPPER = randomBytes(32).toString("base64");
const codec = createPublicIdCodec(PEPPER);
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

maybe("webhooks endpoints (PAPI-062)", () => {
  const { db, sql } = createDb(url as string);
  let app: FastifyInstance;
  const users: string[] = [];
  const A = { ws: "", key: "", testKey: "", narrowKey: "", keyId: "" };
  const B = { ws: "", key: "" };

  async function workspace() {
    const ws = randomUUID();
    await db.insert(schema.workspaces).values({ id: ws, name: "PAPI-062", slug: `papi062-${ws}` });
    const [u] = await db.insert(schema.users).values({ email: `papi062-${ws.slice(0, 8)}@test.com`, isActive: true }).returning();
    users.push(u!.id);
    await db.insert(schema.workspaceMembers).values({ workspaceId: ws, userId: u!.id, role: "owner" });
    await db.insert(schema.workspaceApiSettings).values({ workspaceId: ws, addonEnabled: true });
    await postCreditTransaction(db, { workspaceId: ws, amount: 100, kind: "purchase", action: "test" });
    const mk = (type: "live" | "test", scopes: string[]) =>
      createPublicApiKey(db, { pepper: PEPPER, maxActiveKeys: 10 }, { workspaceId: ws, userId: u!.id }, { name: type, type, scopes });
    const live = await mk("live", ["webhooks:manage"]);
    return {
      ws,
      key: live.key,
      keyId: live.id,
      testKey: (await mk("test", ["webhooks:manage"])).key,
      narrowKey: (await mk("live", ["people:read"])).key,
    };
  }
  const call = (method: "GET" | "POST" | "DELETE", key: string, path = "", body?: unknown) =>
    app.inject({
      method,
      url: `/api/public/v1/webhooks${path}`,
      headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { payload: JSON.stringify(body) } : {}),
    });

  beforeAll(async () => {
    Object.assign(A, await workspace());
    Object.assign(B, await workspace());
    app = Fastify({ genReqId: () => randomUUID() });
    app.decorate("config", { API_KEY_PEPPER: PEPPER, PUBLIC_API_MAX_ACTIVE_KEYS: 10 } as never);
    app.decorate("db", db);
    app.decorate("publicKeyCache", null);
    registerPublicApiAuth(app, { limiter: createMemoryFailedAuthLimiter({ perMinute: 1000, blockMinutes: 15 }) });
    const deps = { env: {} as never, db };
    await app.register(publicApiPlugin, {
      prefix: "/api/public/v1",
      deps: {
        db,
        pricing: new ApiPricingService(db, { INTERNAL_WORKSPACE_ID: randomUUID(), searchCreditCost: 1 }),
        quotas: createMemoryQuotaStore(),
        limitDefaults: { verifyDailyQuota: 5000, searchDailyQuota: 10000 },
        enabled: true,
        ids: codec,
      },
      endpoints: [createListWebhooksEndpoint(deps) as never, createCreateWebhookEndpoint(deps) as never, createDeleteWebhookEndpoint(deps) as never],
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    for (const ws of [A.ws, B.ws]) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, ws));
    for (const u of users) await db.delete(schema.users).where(eq(schema.users.id, u));
    await sql.end();
  });

  it("creates a webhook for public API events, returns its secret once, and lists only API webhooks", async () => {
    // The app's own webhook endpoint in the same workspace: never visible to API keys.
    const [appHook] = await db
      .insert(schema.webhookEndpoints)
      .values({ workspaceId: A.ws, url: "https://app.example.com/hook", secret: "s", eventTypes: ["reply.received"] })
      .returning();
    const res = await call("POST", A.key, "", { url: "https://hooks.example.com/skout", events: ["api.job.completed", "credits.low", "api.job.completed"], description: "jobs" });
    expect(res.statusCode).toBe(201);
    const created = res.json().data;
    expect(created).toMatchObject({ url: "https://hooks.example.com/skout", events: ["api.job.completed", "credits.low"], description: "jobs", enabled: true });
    expect(created.id).toMatch(/^whk_/);
    expect(created.secret).toMatch(/^[0-9a-f]{32}$/);
    expect(res.body).not.toMatch(UUID_RE);
    const [row] = await db.select().from(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.id, codec.decode("webhook", created.id)!));
    expect(row).toMatchObject({ source: "public_api", workspaceId: A.ws });

    const list = await call("GET", A.key);
    expect(list.statusCode).toBe(200);
    expect(list.json().data.webhooks).toEqual([expect.not.objectContaining({ secret: expect.anything() })]);
    expect(list.json().data.webhooks[0].id).toBe(created.id);
    expect(list.body).not.toContain("app.example.com");
    // The app hook can't be deleted through the API.
    expect((await call("DELETE", A.key, `/${codec.encode("webhook", appHook!.id)}`)).statusCode).toBe(404);
  });

  it("deletes only its own workspace's API webhooks", async () => {
    const created = (await call("POST", A.key, "", { url: "https://hooks.example.com/del", events: ["api_key.revoked"] })).json().data;
    expect((await call("DELETE", B.key, `/${created.id}`)).statusCode).toBe(404);
    expect((await call("GET", B.key)).json().data.webhooks).toEqual([]);
    const del = await call("DELETE", A.key, `/${created.id}`);
    expect(del.statusCode).toBe(200);
    expect(del.json().data).toEqual({ id: created.id, deleted: true });
    expect((await call("DELETE", A.key, `/${created.id}`)).statusCode).toBe(404);
    expect((await call("DELETE", A.key, "/whk_forged")).statusCode).toBe(404);
  });

  it("requires https and public API events, caps API webhooks per workspace, needs webhooks:manage, and fixtures test keys", async () => {
    for (const body of [
      { url: "http://hooks.example.com/x", events: ["credits.low"] },
      { url: "not a url", events: ["credits.low"] },
      { url: "https://hooks.example.com/x", events: [] },
      { url: "https://hooks.example.com/x", events: ["reply.received"] },
      { url: "https://hooks.example.com/x", events: ["credits.low"], secret: "mine" },
    ]) {
      expect((await call("POST", A.key, "", body)).statusCode, JSON.stringify(body)).toBe(422);
    }
    expect((await call("GET", A.narrowKey)).statusCode).toBe(403);
    const have = (await call("GET", A.key)).json().data.webhooks.length;
    for (let i = have; i < MAX_API_WEBHOOKS; i++) {
      expect((await call("POST", A.key, "", { url: `https://hooks.example.com/${i}`, events: ["credits.low"] })).statusCode).toBe(201);
    }
    const over = await call("POST", A.key, "", { url: "https://hooks.example.com/over", events: ["credits.low"] });
    expect(over.statusCode).toBe(422);
    expect(over.json().error.message).toMatch(/up to 10/);
    const fx = await call("POST", A.testKey, "", { url: "https://hooks.example.com/t", events: ["credits.low"] });
    expect(fx.json().data.id).toBe("whk_test_example");
  });

  it("sends api.job.completed or api.job.failed with the public job id when a job finishes (JOB-3)", async () => {
    const sent: { event: string; ws: string; payload: Record<string, unknown> }[] = [];
    const dispatch = async (event: string, ws: string, payload: Record<string, unknown>) => void sent.push({ event, ws, payload });
    const job = async (status: string, succeeded: number, failed: number) => {
      const [row] = await db
        .insert(schema.apiJobs)
        .values({
          workspaceId: A.ws,
          apiKeyId: A.keyId,
          requestId: randomUUID(),
          operation: "emails.verify",
          status,
          totalItems: 2,
          processedItems: succeeded + failed,
          succeededItems: succeeded,
          failedItems: failed,
          finishedAt: new Date(),
        })
        .returning();
      return row!.id;
    };
    const ok = await job("partially_completed", 1, 1);
    const bad = await job("failed", 0, 2);
    const running = await job("running", 0, 0);
    for (const id of [ok, bad, running]) await notifyJobFinished(db, id, (x) => codec.encode("job", x), dispatch);
    expect(sent.map((s) => s.event)).toEqual(["api.job.completed", "api.job.failed"]);
    expect(sent[0]).toMatchObject({ ws: A.ws, payload: { job_id: codec.encode("job", ok), type: "emails.verify", status: "partially_completed", succeeded: 1, failed: 1 } });
    expect(JSON.stringify(sent)).not.toContain(ok);
  });
});
