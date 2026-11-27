import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb, maintainPublicApiTables, postCreditTransaction, schema } from "@skout/db";
import { registerPublicApiAuth } from "../../plugins/public-api-auth.js";
import { createMemoryFailedAuthLimiter } from "../../lib/failed-auth-limiter.js";
import { createMemoryQuotaStore } from "../../lib/api-quota.js";
import { ApiPricingService } from "../../services/api-pricing.service.js";
import { createPublicApiKey } from "../../services/public-api-keys.service.js";
import { availableCredits } from "../../services/api-credits.service.js";
import type { EmailIntelVerifyResult } from "../../services/email-intel.service.js";
import { publicApiPlugin } from "../plugin.js";
import { createPublicIdCodec } from "../ids.js";
import { createVerifyEmailBatchEndpoint, runPublicApiJob } from "./emails.js";

/** PAPI-058: POST /emails/verify/batch, an async job (JOB-1, JOB-2), on real Postgres; verifier faked. */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const PEPPER = randomBytes(32).toString("base64");
const codec = createPublicIdCodec(PEPPER);
const QUOTA = 8;
const env = {} as never;

const intel = (status: string): EmailIntelVerifyResult =>
  ({ success: true, email: "x", domain: "x", disposable: false, verificationStatus: { status } }) as EmailIntelVerifyResult;

maybe("email verify batch (PAPI-058)", () => {
  const { db, sql } = createDb(url as string);
  let app: FastifyInstance;
  const queued: string[] = [];
  const users: string[] = [];
  const A = { ws: "", key: "", quotaKey: "", testKey: "", narrowKey: "" };
  const P = { ws: "", key: "" };
  // Emails containing "down" can't be verified (service error); the rest are valid.
  const verify = async (email: string) => {
    if (email.includes("down")) throw new Error("service down");
    return intel(email.includes("bad") ? "INVALID" : "VERIFIED");
  };

  async function workspace(price?: number) {
    const ws = randomUUID();
    await db.insert(schema.workspaces).values({ id: ws, name: "PAPI-058", slug: `papi058-${ws}` });
    const [u] = await db.insert(schema.users).values({ email: `papi058-${ws.slice(0, 8)}@test.com`, isActive: true }).returning();
    users.push(u!.id);
    await db.insert(schema.workspaceMembers).values({ workspaceId: ws, userId: u!.id, role: "owner" });
    await db.insert(schema.workspaceApiSettings).values({ workspaceId: ws, addonEnabled: true });
    await postCreditTransaction(db, { workspaceId: ws, amount: 100, kind: "purchase", action: "test" });
    if (price !== undefined) await db.insert(schema.entitlements).values({ workspaceId: ws, key: "api.price.emails.verify", value: price, source: "test" });
    const mk = (type: "live" | "test", scopes: string[]) =>
      createPublicApiKey(db, { pepper: PEPPER, maxActiveKeys: 10 }, { workspaceId: ws, userId: u!.id }, { name: type, type, scopes });
    return {
      ws,
      key: (await mk("live", ["email:verify"])).key,
      quotaKey: (await mk("live", ["email:verify"])).key,
      testKey: (await mk("test", ["email:verify"])).key,
      narrowKey: (await mk("live", ["people:read"])).key,
    };
  }
  const batch = (key: string, emails: string[]) =>
    app.inject({
      method: "POST",
      url: "/api/public/v1/emails/verify/batch",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": randomUUID() },
      payload: JSON.stringify({ emails }),
    });
  const job = async (publicId: string) => {
    const [row] = await db.select().from(schema.apiJobs).where(eq(schema.apiJobs.id, codec.decode("job", publicId)!));
    return row!;
  };
  const credits = (ws: string) => availableCredits(db, ws);

  beforeAll(async () => {
    Object.assign(A, await workspace());
    Object.assign(P, await workspace(2)); // a workspace whose verification price was raised to 2
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
        ids: codec,
      },
      endpoints: [createVerifyEmailBatchEndpoint({ env, db, verify, enqueue: async (id) => void queued.push(id) }) as never],
    });
    await app.ready();
  });

  beforeEach(() => {
    queued.length = 0;
  });

  afterAll(async () => {
    await app.close();
    for (const ws of [A.ws, P.ws]) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, ws));
    for (const u of users) await db.delete(schema.users).where(eq(schema.users.id, u));
    await sql.end();
  });

  it("answers 202 with a job id, reserves the whole batch at the current price, then charges only verified items", async () => {
    const before = await credits(P.ws);
    const res = await batch(P.key, ["a@acme.com", "bad@acme.com", "down@acme.com", "A@acme.com"]);
    expect(res.statusCode).toBe(202);
    const data = res.json().data;
    expect(data).toMatchObject({ status: "queued", total: 3 }); // the repeated a@acme.com counts once
    expect(data.job_id).toMatch(/^job_/);
    expect(res.headers["x-credits-charged"]).toBe("0");
    // JOB-1: 3 emails × 2 credits held while the job runs.
    expect((await credits(P.ws)).held).toBe(before.held + 6);
    expect(queued).toEqual([codec.decode("job", data.job_id)]);
    expect((await job(data.job_id)).status).toBe("queued");

    expect(await runPublicApiJob(db, env, queued[0]!, verify)).toBe("partially_completed");
    const row = await job(data.job_id);
    expect(row).toMatchObject({ status: "partially_completed", totalItems: 3, processedItems: 3, succeededItems: 2, failedItems: 1 });
    expect(row.results).toEqual([
      expect.objectContaining({ email: "a@acme.com", status: "valid" }),
      expect.objectContaining({ email: "bad@acme.com", status: "invalid" }),
      { email: "down@acme.com", status: null, error: "verification_failed" },
    ]);
    expect(row.resultsExpireAt!.getTime() - row.finishedAt!.getTime()).toBe(7 * 86_400_000);
    // Two verified items charged at 2 each; the third item's credits released.
    const after = await credits(P.ws);
    expect(after.balance).toBe(before.balance - 4);
    expect(after.held).toBe(before.held);
    // A second run of the same job does nothing.
    expect(await runPublicApiJob(db, env, queued[0]!, verify)).toBeNull();
    expect((await credits(P.ws)).balance).toBe(before.balance - 4);
  });

  it("charges nothing when no item could be verified, and is free by default (D5)", async () => {
    const pBefore = await credits(P.ws);
    const down = await batch(P.key, ["down1@acme.com", "down2@acme.com"]);
    expect(await runPublicApiJob(db, env, queued[0]!, verify)).toBe("failed");
    expect((await job(down.json().data.job_id)).errorCode).toBe("all_items_failed");
    expect(await credits(P.ws)).toEqual(pBefore);

    const aBefore = await credits(A.ws);
    const free = await batch(A.key, ["x@acme.com", "y@acme.com"]);
    expect(free.statusCode).toBe(202);
    expect(await runPublicApiJob(db, env, queued[1]!, verify)).toBe("completed");
    expect((await job(free.json().data.job_id)).holdId).toBeNull();
    expect(await credits(A.ws)).toEqual(aBefore);
  });

  it("counts the whole batch toward the key's daily verification quota (RL-5)", async () => {
    const emails = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i}@acme.com`);
    expect((await batch(A.quotaKey, emails(6, "q"))).statusCode).toBe(202);
    const over = await batch(A.quotaKey, emails(3, "r"));
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe("quota_reached");
    expect((await batch(A.quotaKey, emails(2, "s"))).statusCode).toBe(202);
  });

  it("refuses more than 1,000 emails or a bad one, needs email:verify, and serves test keys a fixture", async () => {
    const many = Array.from({ length: 1001 }, (_, i) => `m${i}@acme.com`);
    expect((await batch(A.key, many)).statusCode).toBe(422);
    expect((await batch(A.key, [])).statusCode).toBe(422);
    expect((await batch(A.key, ["ok@acme.com", "not-an-email"])).statusCode).toBe(422);
    expect((await batch(A.narrowKey, ["a@acme.com"])).statusCode).toBe(403);
    const fx = await batch(A.testKey, ["a@acme.com"]);
    expect(fx.statusCode).toBe(200);
    expect(fx.json().data).toEqual({ job_id: "job_test_verify_batch", status: "queued", total: 1 });
    expect(queued).toHaveLength(0);
  });

  it("maintenance gives up a job stuck for 6 hours and deletes jobs 7 days after they finish (JOB-2)", async () => {
    const res = await batch(A.key, ["stuck@acme.com"]);
    const id = codec.decode("job", res.json().data.job_id)!;
    const later = new Date(Date.now() + 7 * 3_600_000);
    await maintainPublicApiTables(db, later);
    const [stuck] = await db.select().from(schema.apiJobs).where(eq(schema.apiJobs.id, id));
    expect(stuck).toMatchObject({ status: "failed", errorCode: "timed_out" });
    await maintainPublicApiTables(db, new Date(later.getTime() + 8 * 86_400_000));
    expect(await db.select().from(schema.apiJobs).where(eq(schema.apiJobs.id, id))).toHaveLength(0);
  });
});
