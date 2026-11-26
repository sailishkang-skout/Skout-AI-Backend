import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb, postCreditTransaction, schema } from "@skout/db";
import { registerPublicApiAuth } from "../../plugins/public-api-auth.js";
import { createMemoryFailedAuthLimiter } from "../../lib/failed-auth-limiter.js";
import { createMemoryQuotaStore } from "../../lib/api-quota.js";
import { ApiPricingService } from "../../services/api-pricing.service.js";
import { createPublicApiKey } from "../../services/public-api-keys.service.js";
import { availableCredits } from "../../services/api-credits.service.js";
import type { EmailIntelVerifyResult } from "../../services/email-intel.service.js";
import { publicApiPlugin } from "../plugin.js";
import { createPublicIdCodec } from "../ids.js";
import { createVerifyEmailEndpoint, toPublicVerification } from "./emails.js";

/** PAPI-057: POST /emails/verify on real Postgres; the verifier faked. */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const PEPPER = randomBytes(32).toString("base64");
const QUOTA = 3;

const intel = (status: string, extra: Partial<EmailIntelVerifyResult> = {}): EmailIntelVerifyResult =>
  ({ success: true, email: "x", domain: "x", disposable: false, verificationStatus: { status }, ...extra }) as EmailIntelVerifyResult;

describe("toPublicVerification", () => {
  it("maps the service's statuses to the public five", () => {
    const s = (r: EmailIntelVerifyResult) => toPublicVerification("a@b.com", r).status;
    expect(s(intel("VERIFIED"))).toBe("valid");
    expect(s(intel("INVALID"))).toBe("invalid");
    expect(s(intel("CATCH_ALL"))).toBe("catch_all");
    expect(s(intel("TEMPORARY"))).toBe("risky");
    expect(s(intel("SMTP_ERROR"))).toBe("unknown");
    expect(s(intel("VERIFIED", { disposable: true }))).toBe("risky");
    expect(s(intel("VERIFIED", { success: false }))).toBe("unknown");
  });
});

maybe("email verify endpoint (PAPI-057)", () => {
  const { db, sql } = createDb(url as string);
  let app: FastifyInstance;
  let verifier: (email: string) => Promise<EmailIntelVerifyResult> = async () => intel("VERIFIED");
  const users: string[] = [];
  const A = { ws: "", key: "", key2: "", testKey: "", narrowKey: "" };
  const B = { ws: "", key: "" };

  async function workspace() {
    const ws = randomUUID();
    await db.insert(schema.workspaces).values({ id: ws, name: "PAPI-057", slug: `papi057-${ws}` });
    const [u] = await db.insert(schema.users).values({ email: `papi057-${ws.slice(0, 8)}@test.com` }).returning();
    users.push(u!.id);
    await db.insert(schema.workspaceMembers).values({ workspaceId: ws, userId: u!.id, role: "owner" });
    await db.insert(schema.workspaceApiSettings).values({ workspaceId: ws, addonEnabled: true });
    await postCreditTransaction(db, { workspaceId: ws, amount: 100, kind: "purchase", action: "test" });
    const mk = (type: "live" | "test", scopes: string[]) =>
      createPublicApiKey(db, { pepper: PEPPER, maxActiveKeys: 10 }, { workspaceId: ws, userId: u!.id }, { name: type, type, scopes });
    return {
      ws,
      key: (await mk("live", ["email:verify"])).key,
      key2: (await mk("live", ["email:verify"])).key,
      testKey: (await mk("test", ["email:verify"])).key,
      narrowKey: (await mk("live", ["people:read"])).key,
    };
  }
  const verify = (key: string, body: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/api/public/v1/emails/verify",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": randomUUID() },
      payload: JSON.stringify(body),
    });
  const balance = async (ws: string) => (await availableCredits(db, ws)).balance;

  beforeAll(async () => {
    Object.assign(A, await workspace());
    Object.assign(B, await workspace());
    // B's verification price was raised through config (D5: the price can be raised later).
    await db.insert(schema.entitlements).values({ workspaceId: B.ws, key: "api.price.emails.verify", value: 2, source: "test" });
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
        quotas: createMemoryQuotaStore(),
        limitDefaults: { verifyDailyQuota: QUOTA, searchDailyQuota: 10000 },
        enabled: true,
        ids: createPublicIdCodec(PEPPER),
      },
      endpoints: [createVerifyEmailEndpoint({ env: {} as never, db, verify: (e) => verifier(e) }) as never],
    });
    await app.ready();
  });

  beforeEach(() => {
    verifier = async () => intel("VERIFIED");
  });

  afterAll(async () => {
    await app.close();
    for (const ws of [A.ws, B.ws]) await db.delete(schema.providerCostEvents).where(eq(schema.providerCostEvents.workspaceId, ws));
    for (const ws of [A.ws, B.ws]) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, ws));
    for (const u of users) await db.delete(schema.users).where(eq(schema.users.id, u));
    await sql.end();
  });

  it("verifies an email for free by default (D5), with no service or provider name in the response", async () => {
    verifier = async () => intel("CATCH_ALL", { catchAll: true, provider: "hunter-fallback", suggestedDomain: undefined });
    const before = await balance(A.ws);
    const res = await verify(A.key, { email: " Ada@Acme.COM " });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ email: "ada@acme.com", status: "catch_all", catch_all: true, disposable: false, suggested_domain: null });
    expect(res.headers["x-credits-charged"]).toBe("0");
    expect(await balance(A.ws)).toBe(before);
    expect(res.body.toLowerCase()).not.toContain("hunter");
    // The webmail fallback is a paid provider call: its cost is recorded against the key.
    const costs = await db.select().from(schema.providerCostEvents).where(eq(schema.providerCostEvents.workspaceId, A.ws));
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({ provider: "hunter", operation: "verify" });
  });

  it("enforces the per-key daily verification quota (RL-5) and gives a unit back when verification fails", async () => {
    verifier = async () => {
      throw new Error("service down");
    };
    const down = await verify(A.key2, { email: "a@acme.com" });
    expect(down.statusCode).toBe(503);
    expect(down.json().error.code).toBe("upstream_unavailable");
    verifier = async () => intel("VERIFIED");
    for (let i = 0; i < QUOTA; i++) expect((await verify(A.key2, { email: `p${i}@acme.com` })).statusCode).toBe(200);
    const over = await verify(A.key2, { email: "over@acme.com" });
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe("quota_reached");
  });

  it("charges the configured price when a workspace's verification price is raised", async () => {
    const before = await balance(B.ws);
    const res = await verify(B.key, { email: "grace@navy.mil" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-credits-charged"]).toBe("2");
    expect(await balance(B.ws)).toBe(before - 2);
  });

  it("validates strictly, needs email:verify, and serves test keys a free fixture", async () => {
    for (const body of [{}, { email: "not-an-email" }, { email: "a@b.com", workspace_id: B.ws }, { emails: ["a@b.com"] }]) {
      expect((await verify(A.key, body)).statusCode, JSON.stringify(body)).toBe(422);
    }
    expect((await verify(A.narrowKey, { email: "a@b.com" })).statusCode).toBe(403);
    let called = false;
    verifier = async () => ((called = true), intel("VERIFIED"));
    const fx = await verify(A.testKey, { email: "ada@example.com" });
    expect(fx.statusCode).toBe(200);
    expect(fx.json().data.status).toBe("valid");
    expect(called).toBe(false);
  });
});
