import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const osSearch = vi.fn();
vi.mock("@skout/opensearch", async (orig) => ({
  ...(await orig<typeof import("@skout/opensearch")>()),
  searchProspects: (...a: unknown[]) => osSearch(...a),
}));
// The workspace's own captured companies (research service). Mocked so this test never touches CRM tables.
const researchCompany = vi.fn();
vi.mock("../../services/enrichment/research.service.js", async (orig) => ({
  ...(await orig<typeof import("../../services/enrichment/research.service.js")>()),
  getCompany: (...a: unknown[]) => researchCompany(...a),
}));

import Fastify, { type FastifyInstance } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createDb, postCreditTransaction, schema } from "@skout/db";
import { registerPublicApiAuth } from "../../plugins/public-api-auth.js";
import { createMemoryFailedAuthLimiter } from "../../lib/failed-auth-limiter.js";
import { createMemoryQuotaStore } from "../../lib/api-quota.js";
import { ApiPricingService } from "../../services/api-pricing.service.js";
import { createPublicApiKey } from "../../services/public-api-keys.service.js";
import { availableCredits } from "../../services/api-credits.service.js";
import { publicApiPlugin } from "../plugin.js";
import { createPublicIdCodec } from "../ids.js";
import { companyPublicId, createGetCompanyEndpoint, createMatchCompanyEndpoint } from "./companies.js";

/** PAPI-053: POST /companies/match and GET /companies/{id} on real Postgres, OpenSearch and research mocked. */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const PEPPER = randomBytes(32).toString("base64");
const codec = createPublicIdCodec(PEPPER);
const env = { OPENSEARCH_URL: "https://os.test" } as never;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const person = (extra: Record<string, unknown>) => ({
  prospectId: randomBytes(32).toString("hex"),
  companyId: randomBytes(32).toString("hex"),
  fullName: "Someone",
  companyDomain: "acme.com",
  email: "someone@acme.com",
  dataVendors: ["wiza"],
  ...extra,
});
const acmeHits = [
  person({ companyName: "Acme", industry: "Software", employeeCount: 250 }),
  person({ companyDomain: "www.acme.com", companyStage: "series_b", totalFunding: 40_000_000, techStack: [{ category: "crm", technology: "Salesforce" }] }),
  person({ companyDomain: "acme.com.evil.test", companyName: "Not Acme" }),
];

maybe("company lookup endpoints (PAPI-053)", () => {
  const { db, sql } = createDb(url as string);
  let app: FastifyInstance;
  const users: string[] = [];
  const A = { ws: "", key: "", testKey: "", narrowKey: "" };
  const B = { ws: "", key: "" };

  async function workspace() {
    const ws = randomUUID();
    await db.insert(schema.workspaces).values({ id: ws, name: "PAPI-053", slug: `papi053-${ws}` });
    const [u] = await db.insert(schema.users).values({ email: `papi053-${ws.slice(0, 8)}@test.com` }).returning();
    users.push(u!.id);
    await db.insert(schema.workspaceMembers).values({ workspaceId: ws, userId: u!.id, role: "owner" });
    await db.insert(schema.workspaceApiSettings).values({ workspaceId: ws, addonEnabled: true });
    await postCreditTransaction(db, { workspaceId: ws, amount: 100, kind: "purchase", action: "test" });
    const mk = (type: "live" | "test", scopes: string[]) =>
      createPublicApiKey(db, { pepper: PEPPER, maxActiveKeys: 10 }, { workspaceId: ws, userId: u!.id }, { name: type, type, scopes });
    return {
      ws,
      key: (await mk("live", ["companies:read"])).key,
      testKey: (await mk("test", ["companies:read"])).key,
      narrowKey: (await mk("live", ["people:read"])).key,
    };
  }
  const match = (key: string, body: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/api/public/v1/companies/match",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": randomUUID() },
      payload: JSON.stringify(body),
    });
  const get = (key: string, id: string) => app.inject({ method: "GET", url: `/api/public/v1/companies/${encodeURIComponent(id)}`, headers: { authorization: `Bearer ${key}` } });
  const balance = async (ws: string) => (await availableCredits(db, ws)).balance;

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
      endpoints: [createMatchCompanyEndpoint({ env, db }) as never, createGetCompanyEndpoint({ env, db }) as never],
    });
    await app.ready();
  });

  beforeEach(async () => {
    osSearch.mockReset();
    researchCompany.mockReset();
    osSearch.mockImplementation(async (_c: unknown, filters: { companyDomain?: string }) =>
      filters.companyDomain === "acme.com" ? { hits: acmeHits, total: 3 } : { hits: [], total: 0 }
    );
    researchCompany.mockResolvedValue(null);
    for (const ws of [A.ws, B.ws]) await db.delete(schema.apiDatumCache).where(eq(schema.apiDatumCache.workspaceId, ws));
  });

  afterAll(async () => {
    await app.close();
    for (const ws of [A.ws, B.ws]) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, ws));
    for (const u of users) await db.delete(schema.users).where(eq(schema.users.id, u));
    await sql.end();
  });

  it("matches by domain: merged firmographics for that exact domain, companies.lookup charged, no internals", async () => {
    const before = await balance(A.ws);
    const res = await match(A.key, { domain: "https://www.Acme.com/about" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      id: companyPublicId(codec, "acme.com"),
      name: "Acme",
      domain: "acme.com",
      industry: "Software",
      employee_count: 250,
      stage: "series_b",
      funding: { total: 40_000_000 },
      tech_stack: [{ category: "crm", technology: "Salesforce" }],
    });
    expect(res.headers["x-credits-charged"]).toBe("1");
    expect(await balance(A.ws)).toBe(before - 1);
    for (const leak of ["Not Acme", "someone@acme.com", "wiza"]) expect(res.body).not.toContain(leak);
    expect(res.body).not.toMatch(UUID_RE);
  });

  it("GET /companies/{id} takes the id search and people lookups give, and a 30-day repeat is free", async () => {
    const id = companyPublicId(codec, "acme.com");
    const first = await get(A.key, id);
    expect(first.statusCode).toBe(200);
    expect(first.json().data.name).toBe("Acme");
    expect(first.headers["x-credits-charged"]).toBe("1");
    expect((await get(A.key, id)).headers["x-credits-charged"]).toBe("0");
    expect((await match(A.key, { domain: "acme.com" })).headers["x-credits-charged"]).toBe("0");
  });

  it("matches a LinkedIn company page through the workspace's own capture, adding headquarters and the LinkedIn URL", async () => {
    const capturedId = randomUUID();
    await db.insert(schema.enrichmentIdentities).values({ workspaceId: A.ws, entityType: "company", canonicalKey: "company:acme-inc", entityId: capturedId });
    researchCompany.mockImplementation(async (_db: unknown, ws: string, id: string) =>
      ws === A.ws && id === capturedId
        ? { id: capturedId, name: "Acme Inc", domain: "acme.com", industry: null, employeeCount: null, linkedinUrl: "https://www.linkedin.com/company/acme-inc/", capture: { size: "201-500", headquarter: "Pune, Maharashtra", country: "IN", foundedAt: "2015" } }
        : null
    );
    const res = await match(A.key, { linkedin_url: "https://www.linkedin.com/company/acme-inc/about/" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      id: companyPublicId(codec, "acme.com"),
      name: "Acme",
      linkedin_url: "https://www.linkedin.com/company/acme-inc/",
      headquarters: { country: "IN", location: "Pune, Maharashtra" },
    });
    // Another workspace hasn't captured it: no match.
    expect((await match(B.key, { linkedin_url: "https://www.linkedin.com/company/acme-inc/" })).statusCode).toBe(404);
  });

  it("charges nothing when no company matches, the id is bad, or the index is down", async () => {
    const before = await balance(A.ws);
    for (const res of [
      await match(A.key, { domain: "unknown-company.test" }),
      await match(A.key, { linkedin_url: "https://linkedin.com/company/never-captured" }),
      await get(A.key, companyPublicId(codec, "unknown-company.test")),
      await get(A.key, "com_forged"),
      await get(A.key, codec.encode("person", "domain:acme.com")),
      await get(A.key, codec.encode("company", `ws:${randomUUID()}`)),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("not_found");
    }
    osSearch.mockRejectedValue(new Error("index down"));
    const down = await match(A.key, { domain: "acme.com" });
    expect(down.statusCode).toBe(503);
    expect(await balance(A.ws)).toBe(before);
  });

  it("keeps workspaces apart: B pays for a company A already looked up, B can't open A's captured-only company, workspace_id refused", async () => {
    expect((await match(A.key, { domain: "acme.com" })).headers["x-credits-charged"]).toBe("1");
    expect((await match(B.key, { domain: "acme.com" })).headers["x-credits-charged"]).toBe("1");
    const capturedOnly = codec.encode("company", `ws:${randomUUID()}`);
    researchCompany.mockImplementation(async (_db: unknown, ws: string) => (ws === A.ws ? { id: "x", name: "Stealth Co", domain: null, capture: {} } : null));
    expect((await get(A.key, capturedOnly)).statusCode).toBe(200);
    expect((await get(B.key, capturedOnly)).statusCode).toBe(404);
    expect((await match(B.key, { domain: "acme.com", workspace_id: A.ws })).statusCode).toBe(422);
  });

  it("validates strictly, needs companies:read, and serves test keys fixtures for free", async () => {
    for (const body of [{}, { domain: "acme.com", linkedin_url: "https://linkedin.com/company/acme" }, { domain: "not a domain" }, { linkedin_url: "https://linkedin.com/in/ada" }]) {
      expect((await match(A.key, body)).statusCode, JSON.stringify(body)).toBe(422);
    }
    expect((await match(A.narrowKey, { domain: "acme.com" })).statusCode).toBe(403);
    const before = await balance(A.ws);
    const fx = await match(A.testKey, { domain: "acme.com" });
    expect(fx.statusCode).toBe(200);
    expect(fx.json().data.name).toBe("Analytical Engines Ltd");
    expect(osSearch).not.toHaveBeenCalled();
    expect(await balance(A.ws)).toBe(before);
  });
});
