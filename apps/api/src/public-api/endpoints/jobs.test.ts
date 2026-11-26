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
import type { EmailIntelVerifyResult } from "../../services/email-intel.service.js";
import { publicApiPlugin } from "../plugin.js";
import { createPublicIdCodec } from "../ids.js";
import { createVerifyEmailBatchEndpoint, runPublicApiJob } from "./emails.js";
import { createGetJobEndpoint } from "./jobs.js";

/** PAPI-060: GET /jobs/{id} on real Postgres, with a batch job made through PAPI-058. */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const PEPPER = randomBytes(32).toString("base64");
const codec = createPublicIdCodec(PEPPER);
const env = {} as never;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const verify = async (email: string): Promise<EmailIntelVerifyResult> => {
  if (email.includes("down")) throw new Error("service down");
  return { success: true, email, domain: "acme.com", disposable: false, verificationStatus: { status: "VERIFIED" } } as EmailIntelVerifyResult;
};

maybe("get job endpoint (PAPI-060)", () => {
  const { db, sql } = createDb(url as string);
  let app: FastifyInstance;
  const queued: string[] = [];
  const users: string[] = [];
  const A = { ws: "", key: "", otherScopeKey: "", testKey: "" };
  const B = { ws: "", key: "" };

  async function workspace() {
    const ws = randomUUID();
    await db.insert(schema.workspaces).values({ id: ws, name: "PAPI-060", slug: `papi060-${ws}` });
    const [u] = await db.insert(schema.users).values({ email: `papi060-${ws.slice(0, 8)}@test.com`, isActive: true }).returning();
    users.push(u!.id);
    await db.insert(schema.workspaceMembers).values({ workspaceId: ws, userId: u!.id, role: "owner" });
    await db.insert(schema.workspaceApiSettings).values({ workspaceId: ws, addonEnabled: true });
    await postCreditTransaction(db, { workspaceId: ws, amount: 100, kind: "purchase", action: "test" });
    const mk = (type: "live" | "test", scopes: string[]) =>
      createPublicApiKey(db, { pepper: PEPPER, maxActiveKeys: 10 }, { workspaceId: ws, userId: u!.id }, { name: type, type, scopes });
    return {
      ws,
      key: (await mk("live", ["email:verify"])).key,
      otherScopeKey: (await mk("live", ["people:read"])).key,
      testKey: (await mk("test", ["email:verify"])).key,
    };
  }
  const startBatch = async (key: string, emails: string[]) => {
    const res = await app.inject({
      method: "POST",
      url: "/api/public/v1/emails/verify/batch",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": randomUUID() },
      payload: JSON.stringify({ emails }),
    });
    expect(res.statusCode).toBe(202);
    return res.json().data.job_id as string;
  };
  const get = (key: string, id: string) =>
    app.inject({ method: "GET", url: `/api/public/v1/jobs/${encodeURIComponent(id)}`, headers: { authorization: `Bearer ${key}` } });

  beforeAll(async () => {
    Object.assign(A, await workspace());
    Object.assign(B, await workspace());
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
        limitDefaults: { verifyDailyQuota: 5000, searchDailyQuota: 10000 },
        enabled: true,
        ids: codec,
      },
      endpoints: [
        createVerifyEmailBatchEndpoint({ env, db, verify, enqueue: async (id) => void queued.push(id) }) as never,
        createGetJobEndpoint({ env, db }) as never,
      ],
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    for (const ws of [A.ws, B.ws]) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, ws));
    for (const u of users) await db.delete(schema.users).where(eq(schema.users.id, u));
    await sql.end();
  });

  it("shows a queued job without results, then the finished job with its per-item results, for free with any scope", async () => {
    const id = await startBatch(A.key, ["a@acme.com", "down@acme.com"]);
    const queuedRes = await get(A.otherScopeKey, id);
    expect(queuedRes.statusCode).toBe(200);
    expect(queuedRes.json().data).toMatchObject({ id, type: "emails.verify", status: "queued", total: 2, processed: 0, results: null, finished_at: null });
    expect(queuedRes.headers["x-credits-charged"]).toBe("0");

    await runPublicApiJob(db, env, queued.at(-1)!, verify);
    const done = await get(A.key, id);
    const data = done.json().data;
    expect(data).toMatchObject({ status: "partially_completed", total: 2, processed: 2, succeeded: 1, failed: 1, error_code: null });
    expect(data.results).toEqual([
      expect.objectContaining({ email: "a@acme.com", status: "valid" }),
      { email: "down@acme.com", status: null, error: "verification_failed" },
    ]);
    expect(Date.parse(data.results_expire_at) - Date.parse(data.finished_at)).toBe(7 * 86_400_000);
    expect(done.body).not.toMatch(UUID_RE);
  });

  it("keeps jobs to their workspace and forgets them after 7 days", async () => {
    const id = await startBatch(A.key, ["b@acme.com"]);
    await runPublicApiJob(db, env, queued.at(-1)!, verify);
    expect((await get(B.key, id)).statusCode).toBe(404);
    for (const bad of ["job_forged", codec.encode("person", queued.at(-1)!), codec.encode("job", randomUUID())]) {
      const res = await get(A.key, bad);
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("not_found");
    }
    await db.update(schema.apiJobs).set({ resultsExpireAt: new Date(Date.now() - 1000) }).where(eq(schema.apiJobs.id, queued.at(-1)!));
    expect((await get(A.key, id)).statusCode).toBe(404);
  });

  it("serves test keys a fixed finished job", async () => {
    const res = await get(A.testKey, "job_test_verify_batch");
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ id: "job_test_verify_batch", status: "completed", results: [expect.objectContaining({ status: "valid" })] });
  });
});
