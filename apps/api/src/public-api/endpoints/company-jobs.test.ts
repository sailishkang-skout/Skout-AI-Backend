/**
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md.
 *   - Tables touched directly: companies (owned by apps/crm), test setup only: inserts the captured
 *     companies whose job roles the endpoint returns, deleted with the workspace afterwards.
 *   - Owning service: apps/crm
 *   - Reason: PAPI-054 GET /companies/{id}/jobs test; the endpoint reads through
 *     company-jobs.service.ts, which carries the production exception (ENR-02).
 *   - Review date: 2026-11-26
 */
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
import { publicApiPlugin } from "../plugin.js";
import { createPublicIdCodec } from "../ids.js";
import { companyPublicId, createCompanyJobsEndpoint } from "./companies.js";

/** PAPI-054: GET /companies/{id}/jobs on real Postgres. */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const PEPPER = randomBytes(32).toString("base64");
const codec = createPublicIdCodec(PEPPER);
const env = {} as never;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

maybe("company jobs endpoint (PAPI-054)", () => {
  const { db, sql } = createDb(url as string);
  let app: FastifyInstance;
  const users: string[] = [];
  const A = { ws: "", key: "", testKey: "", narrowKey: "", acme: "", stealth: "" };
  const B = { ws: "", key: "" };

  async function workspace() {
    const ws = randomUUID();
    await db.insert(schema.workspaces).values({ id: ws, name: "PAPI-054", slug: `papi054-${ws}` });
    const [u] = await db.insert(schema.users).values({ email: `papi054-${ws.slice(0, 8)}@test.com`, isActive: true }).returning();
    users.push(u!.id);
    await db.insert(schema.workspaceMembers).values({ workspaceId: ws, userId: u!.id, role: "owner" });
    await db.insert(schema.workspaceApiSettings).values({ workspaceId: ws, addonEnabled: true });
    await postCreditTransaction(db, { workspaceId: ws, amount: 100, kind: "purchase", action: "test" });
    const mk = (type: "live" | "test", scopes: string[]) =>
      createPublicApiKey(db, { pepper: PEPPER, maxActiveKeys: 10 }, { workspaceId: ws, userId: u!.id }, { name: type, type, scopes });
    return {
      ws,
      key: (await mk("live", ["jobs:read"])).key,
      testKey: (await mk("test", ["jobs:read"])).key,
      narrowKey: (await mk("live", ["companies:read"])).key,
    };
  }
  async function company(ws: string, name: string, domain: string | null) {
    const [c] = await db.insert(schema.companies).values({ workspaceId: ws, name, domain }).returning({ id: schema.companies.id });
    return c!.id;
  }
  async function role(ws: string, companyId: string, title: string, extra: Partial<typeof schema.companyJobRoles.$inferInsert> = {}) {
    await db.insert(schema.companyJobRoles).values({ workspaceId: ws, companyId, jobKey: `text:${randomUUID()}`, title, ...extra });
  }
  const jobs = (key: string, id: string, qs = "") =>
    app.inject({ method: "GET", url: `/api/public/v1/companies/${encodeURIComponent(id)}/jobs${qs}`, headers: { authorization: `Bearer ${key}` } });
  const balance = async (ws: string) => (await availableCredits(db, ws)).balance;

  beforeAll(async () => {
    Object.assign(A, await workspace());
    Object.assign(B, await workspace());
    A.acme = await company(A.ws, "Acme", "https://www.Acme.com/");
    A.stealth = await company(A.ws, "Stealth Co", null);
    await role(A.ws, A.acme, "Backend Engineer", { department: "Engineering", location: "Pune", workplaceType: "hybrid", postedAt: new Date("2026-11-20") });
    await role(A.ws, A.acme, "Sales Lead", { postedAt: new Date("2026-11-24"), description: "x".repeat(5000) });
    await role(A.ws, A.acme, "Old Role", { status: "not_seen" });
    await role(A.ws, A.stealth, "Founding Engineer");
    await db.insert(schema.companyJobScans).values({ workspaceId: A.ws, companyId: A.acme, status: "completed_verified", verified: true, completedAt: new Date("2026-11-25") });
    // B captured Acme too, with no roles.
    await company(B.ws, "Acme", "acme.com");

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
      endpoints: [createCompanyJobsEndpoint({ env, db }) as never],
    });
    await app.ready();
  });

  beforeEach(async () => {
    for (const ws of [A.ws, B.ws]) await db.delete(schema.apiDatumCache).where(eq(schema.apiDatumCache.workspaceId, ws));
  });

  afterAll(async () => {
    await app.close();
    for (const ws of [A.ws, B.ws]) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, ws));
    for (const u of users) await db.delete(schema.users).where(eq(schema.users.id, u));
    await sql.end();
  });

  it("returns the open roles newest first for the domain id, charges companies.jobs, no internals", async () => {
    const before = await balance(A.ws);
    const id = companyPublicId(codec, "acme.com");
    const res = await jobs(A.key, id);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.company_id).toBe(id);
    expect(data.jobs.map((j: { title: string }) => j.title)).toEqual(["Sales Lead", "Backend Engineer"]);
    expect(data.jobs[1]).toMatchObject({ department: "Engineering", location: "Pune", workplace_type: "hybrid" });
    expect(data.jobs[0].description).toHaveLength(4000);
    expect(data.total_open).toBe(2);
    expect(data.last_scanned_at).toBe("2026-11-25T00:00:00.000Z");
    expect(res.headers["x-credits-charged"]).toBe("1");
    expect(await balance(A.ws)).toBe(before - 1);
    expect(res.body).not.toMatch(UUID_RE);
    expect(res.body).not.toContain("linkedin_extension");
  });

  it("is free when the same roles come back within 30 days, charged again when the list changes", async () => {
    const id = companyPublicId(codec, "acme.com");
    expect((await jobs(A.key, id)).headers["x-credits-charged"]).toBe("1");
    expect((await jobs(A.key, id)).headers["x-credits-charged"]).toBe("0");
    const extra = randomUUID();
    await db.insert(schema.companyJobRoles).values({ id: extra, workspaceId: A.ws, companyId: A.acme, jobKey: `text:${extra}`, title: "New Role" });
    expect((await jobs(A.key, id)).headers["x-credits-charged"]).toBe("1");
    await db.delete(schema.companyJobRoles).where(eq(schema.companyJobRoles.id, extra));
  });

  it("limit caps the list; a company captured without a domain is reachable by its ws id in that workspace only", async () => {
    const one = await jobs(A.key, companyPublicId(codec, "acme.com"), "?limit=1");
    expect(one.json().data.jobs).toHaveLength(1);
    const wsId = companyPublicId(codec, null, A.stealth);
    const res = await jobs(A.key, wsId);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.jobs[0].title).toBe("Founding Engineer");
    expect((await jobs(B.key, wsId)).statusCode).toBe(404);
  });

  it("charges nothing for a company with no roles, one never captured, or a bad id", async () => {
    const empty = await jobs(B.key, companyPublicId(codec, "acme.com"));
    expect(empty.statusCode).toBe(200);
    expect(empty.json().data.jobs).toEqual([]);
    expect(empty.headers["x-credits-charged"]).toBe("0");
    const before = await balance(A.ws);
    for (const id of [companyPublicId(codec, "never-captured.test"), "com_forged", codec.encode("person", "domain:acme.com"), codec.encode("company", `ws:${randomUUID()}`)]) {
      const res = await jobs(A.key, id);
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("not_found");
    }
    expect(await balance(A.ws)).toBe(before);
  });

  it("validates, needs jobs:read, and serves test keys a free fixture", async () => {
    expect((await jobs(A.key, companyPublicId(codec, "acme.com"), "?limit=500")).statusCode).toBe(422);
    expect((await jobs(A.key, companyPublicId(codec, "acme.com"), "?workspace_id=x")).statusCode).toBe(422);
    expect((await jobs(A.narrowKey, companyPublicId(codec, "acme.com"))).statusCode).toBe(403);
    const before = await balance(A.ws);
    const fx = await jobs(A.testKey, companyPublicId(codec, "acme.com"));
    expect(fx.statusCode).toBe(200);
    expect(fx.json().data.jobs[0].title).toBe("Senior Backend Engineer");
    expect(await balance(A.ws)).toBe(before);
  });
});
