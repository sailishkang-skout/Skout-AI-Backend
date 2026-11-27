import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const osGet = vi.fn();
const osSearch = vi.fn();
vi.mock("@skout/opensearch", async (orig) => ({
  ...(await orig<typeof import("@skout/opensearch")>()),
  getProspectById: (...a: unknown[]) => osGet(...a),
  searchProspects: (...a: unknown[]) => osSearch(...a),
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
import { vendorProspectId } from "../../services/vendor-search.service.js";
import { publicApiPlugin } from "../plugin.js";
import { createPublicIdCodec } from "../ids.js";
import { createGetPersonEndpoint, createMatchPersonEndpoint } from "./people.js";

/** PAPI-052: GET /people/{id} and POST /people/match on real Postgres, with OpenSearch mocked. */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const PEPPER = randomBytes(32).toString("base64");
const codec = createPublicIdCodec(PEPPER);
const env = { OPENSEARCH_URL: "https://os.test" } as never;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const adaId = vendorProspectId({ vendor: "wiza", fullName: "Ada L", linkedinUrl: "https://www.linkedin.com/in/ada-l/" });
const ada = {
  prospectId: adaId,
  companyId: randomUUID(),
  fullName: "Ada L",
  title: "CTO",
  seniority: "c_level",
  email: "ada@acme.com",
  phone: "+44 20 0000 0000",
  linkedinUrl: "https://linkedin.com/in/ada-l",
  companyDomain: "acme.com",
  companyName: "Acme",
  country: "GB",
  city: "London",
  dataVendors: ["wiza", "contactout"],
};

maybe("people lookup endpoints (PAPI-052)", () => {
  const { db, sql } = createDb(url as string);
  let app: FastifyInstance;
  const users: string[] = [];
  const A = { ws: "", key: "", testKey: "", narrowKey: "" };
  const B = { ws: "", key: "" };

  async function workspace() {
    const ws = randomUUID();
    await db.insert(schema.workspaces).values({ id: ws, name: "PAPI-052", slug: `papi052-${ws}` });
    const [u] = await db.insert(schema.users).values({ email: `papi052-${ws.slice(0, 8)}@test.com`, isActive: true }).returning();
    users.push(u!.id);
    await db.insert(schema.workspaceMembers).values({ workspaceId: ws, userId: u!.id, role: "owner" });
    await db.insert(schema.workspaceApiSettings).values({ workspaceId: ws, addonEnabled: true });
    await postCreditTransaction(db, { workspaceId: ws, amount: 100, kind: "purchase", action: "test" });
    const mk = (type: "live" | "test", scopes: string[]) =>
      createPublicApiKey(db, { pepper: PEPPER, maxActiveKeys: 10 }, { workspaceId: ws, userId: u!.id }, { name: type, type, scopes });
    return {
      ws,
      key: (await mk("live", ["people:read"])).key,
      testKey: (await mk("test", ["people:read"])).key,
      narrowKey: (await mk("live", ["search:read"])).key,
    };
  }
  const get = (key: string, id: string) => app.inject({ method: "GET", url: `/api/public/v1/people/${encodeURIComponent(id)}`, headers: { authorization: `Bearer ${key}` } });
  const match = (key: string, body: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/api/public/v1/people/match",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": randomUUID() },
      payload: JSON.stringify(body),
    });
  const balance = async (ws: string) => (await availableCredits(db, ws)).balance;
  const clearCache = (ws: string) => db.delete(schema.apiDatumCache).where(eq(schema.apiDatumCache.workspaceId, ws));

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
      endpoints: [createGetPersonEndpoint({ env, db }) as never, createMatchPersonEndpoint({ env, db }) as never],
    });
    await app.ready();
  });

  beforeEach(async () => {
    osGet.mockReset();
    osSearch.mockReset();
    osGet.mockImplementation(async (_cfg: unknown, id: string) => (id === adaId ? ada : null));
    osSearch.mockResolvedValue({ hits: [], total: 0 });
    await clearCache(A.ws);
    await clearCache(B.ws);
  });

  afterAll(async () => {
    await app.close();
    for (const ws of [A.ws, B.ws]) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, ws));
    for (const u of users) await db.delete(schema.users).where(eq(schema.users.id, u));
    await sql.end();
  });

  it("GET /people/{id}: returns the profile for a search id, charges people.lookup, and never shows email, phone or vendors", async () => {
    const before = await balance(A.ws);
    const res = await get(A.key, codec.encode("person", adaId));
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      id: codec.encode("person", adaId),
      full_name: "Ada L",
      title: "CTO",
      company: { id: expect.stringMatching(/^com_/), name: "Acme", domain: "acme.com" },
      location: { country: "GB", city: "London" },
      linkedin_url: "https://linkedin.com/in/ada-l",
    });
    expect(res.headers["x-credits-charged"]).toBe("1");
    expect(await balance(A.ws)).toBe(before - 1);
    for (const secret of ["ada@acme.com", "+44", "wiza", "contactout", "email", "phone"]) expect(res.body.toLowerCase()).not.toContain(secret);
    expect(res.body).not.toMatch(UUID_RE);
  });

  it("is free for the same person within 30 days, whichever endpoint asks", async () => {
    expect((await get(A.key, codec.encode("person", adaId))).headers["x-credits-charged"]).toBe("1");
    expect((await get(A.key, codec.encode("person", adaId))).headers["x-credits-charged"]).toBe("0");
    const byLinkedIn = await match(A.key, { linkedin_url: "https://www.linkedin.com/in/ada-l/" });
    expect(byLinkedIn.statusCode).toBe(200);
    expect(byLinkedIn.headers["x-credits-charged"]).toBe("0");
    expect(byLinkedIn.json().data.id).toBe(codec.encode("person", adaId));
  });

  it("POST /people/match: by LinkedIn URL, or by name and company domain (with an index-search fallback)", async () => {
    const li = await match(A.key, { linkedin_url: "linkedin.com/in/ada-l" });
    expect(li.statusCode).toBe(200);
    expect(li.headers["x-credits-charged"]).toBe("1");

    await clearCache(A.ws);
    const grace = { ...ada, prospectId: randomBytes(32).toString("hex"), fullName: "Grace Hopper", companyDomain: "navy.mil" };
    osGet.mockImplementation(async (_c: unknown, id: string) => (id === grace.prospectId ? grace : null));
    osSearch.mockResolvedValue({ hits: [grace], total: 1 });
    const byName = await match(A.key, { full_name: "Grace Hopper", company_domain: "https://www.navy.mil/" });
    expect(byName.statusCode).toBe(200);
    expect(byName.json().data.full_name).toBe("Grace Hopper");
    expect(osSearch.mock.calls[0]![1]).toMatchObject({ fullName: "Grace Hopper", companyDomain: "navy.mil" });
  });

  it("charges nothing when nobody matches, the id is bad, or the index is down", async () => {
    const before = await balance(A.ws);
    for (const res of [
      await get(A.key, codec.encode("person", randomBytes(32).toString("hex"))),
      await get(A.key, "per_not-a-real-id"),
      await get(A.key, codec.encode("company", adaId)), // a company id used as a person id
      await match(A.key, { linkedin_url: "https://linkedin.com/in/nobody-here" }),
      await match(A.key, { full_name: "No Body", company_domain: "nowhere.test" }),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("not_found");
    }
    osGet.mockRejectedValue(new Error("index down"));
    const down = await get(A.key, codec.encode("person", adaId));
    expect(down.statusCode).toBe(503);
    expect(down.json().error.code).toBe("upstream_unavailable");
    expect(await balance(A.ws)).toBe(before);
  });

  it("keeps workspaces apart: B pays for a person A already has, and workspace_id is refused", async () => {
    expect((await get(A.key, codec.encode("person", adaId))).headers["x-credits-charged"]).toBe("1");
    expect((await get(B.key, codec.encode("person", adaId))).headers["x-credits-charged"]).toBe("1");
    const res = await app.inject({
      method: "GET",
      url: `/api/public/v1/people/${codec.encode("person", adaId)}?workspace_id=${A.ws}`,
      headers: { authorization: `Bearer ${B.key}` },
    });
    expect(res.statusCode).toBe(422);
  });

  it("treats a person whose email the workspace suppressed as not found", async () => {
    await db.insert(schema.suppressions).values({ workspaceId: A.ws, email: "ADA@acme.com", reason: "unsubscribed" });
    try {
      const forA = await get(A.key, codec.encode("person", adaId));
      expect(forA.statusCode).toBe(404);
      expect((await get(B.key, codec.encode("person", adaId))).statusCode).toBe(200);
      expect((await match(A.key, { linkedin_url: "https://linkedin.com/in/ada-l" })).statusCode).toBe(404);
    } finally {
      await db.delete(schema.suppressions).where(and(eq(schema.suppressions.workspaceId, A.ws), eq(schema.suppressions.email, "ADA@acme.com")));
    }
  });

  it("validates match input strictly", async () => {
    for (const body of [
      {},
      { full_name: "Ada L" },
      { company_domain: "acme.com" },
      { linkedin_url: "https://linkedin.com/in/ada", full_name: "Ada L", company_domain: "acme.com" },
      { linkedin_url: "https://example.com/ada" },
      { linkedin_url: "https://linkedin.com/in/ada", email: "x@y.z" },
    ]) {
      expect((await match(A.key, body)).statusCode, JSON.stringify(body)).toBe(422);
    }
  });

  it("needs the people:read scope, and serves test keys fixtures without a lookup or a charge", async () => {
    expect((await get(A.narrowKey, codec.encode("person", adaId))).statusCode).toBe(403);
    const before = await balance(A.ws);
    const fx = await get(A.testKey, codec.encode("person", adaId));
    expect(fx.statusCode).toBe(200);
    expect(fx.json().data.full_name).toBe("Ada Lovelace");
    expect((await match(A.testKey, { linkedin_url: "https://linkedin.com/in/x" })).json().data.full_name).toBe("Ada Lovelace");
    expect(osGet).not.toHaveBeenCalled();
    expect(await balance(A.ws)).toBe(before);
  });
});
