import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const osGet = vi.fn();
vi.mock("@skout/opensearch", async (orig) => ({
  ...(await orig<typeof import("@skout/opensearch")>()),
  getProspectById: (...a: unknown[]) => osGet(...a),
}));

import Fastify, { type FastifyInstance } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createDb, postCreditTransaction, schema } from "@skout/db";
import type { EnrichmentEngine, EnrichmentInput, EnrichmentOutcome } from "@skout/pal";
import { registerPublicApiAuth } from "../../plugins/public-api-auth.js";
import { createMemoryFailedAuthLimiter } from "../../lib/failed-auth-limiter.js";
import { createMemoryQuotaStore } from "../../lib/api-quota.js";
import { ApiPricingService } from "../../services/api-pricing.service.js";
import { createPublicApiKey } from "../../services/public-api-keys.service.js";
import { availableCredits } from "../../services/api-credits.service.js";
import { publicApiPlugin } from "../plugin.js";
import { createPublicIdCodec } from "../ids.js";
import { createEmailFindEndpoint } from "./contacts.js";

/** PAPI-055: POST /contacts/email/find on real Postgres; OpenSearch and the provider waterfall faked. */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const PEPPER = randomBytes(32).toString("base64");
const codec = createPublicIdCodec(PEPPER);
const env = { OPENSEARCH_URL: "https://os.test" } as never;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

type Waterfall = (input: EnrichmentInput) => EnrichmentOutcome;
const found = (email: string, status = "valid"): Waterfall => (input) => ({
  prospectId: input.prospectId,
  results: [
    { field: "email", value: email, provider: "hunter", confidence: 0.9, isPrimary: status === "valid" },
    { field: "email_status", value: status, provider: "zerobounce", validationStatus: status },
  ],
  attempts: [
    { order: 1, provider: "hunter", operation: "findEmail", status: "ok", latencyMs: 5, credentialSource: "platform" },
    { order: 2, provider: "zerobounce", operation: "verify", status: "ok", latencyMs: 5, credentialSource: "platform" },
  ],
  creditsUsed: 1,
});
const nothing: Waterfall = (input) => ({
  prospectId: input.prospectId,
  results: [],
  attempts: [{ order: 1, provider: "hunter", operation: "findEmail", status: "miss", latencyMs: 5, credentialSource: "platform" }],
  creditsUsed: 0,
});
const allFailed: Waterfall = (input) => ({
  prospectId: input.prospectId,
  results: [],
  attempts: [{ order: 1, provider: "hunter", operation: "findEmail", status: "error", latencyMs: 5, detail: "timeout", credentialSource: "platform" }],
  creditsUsed: 0,
});

maybe("email find endpoint (PAPI-055)", () => {
  const { db, sql } = createDb(url as string);
  let app: FastifyInstance;
  let waterfall: Waterfall = nothing;
  const calls: EnrichmentInput[] = [];
  const users: string[] = [];
  const A = { ws: "", key: "", testKey: "", narrowKey: "" };
  const B = { ws: "", key: "" };

  async function workspace() {
    const ws = randomUUID();
    await db.insert(schema.workspaces).values({ id: ws, name: "PAPI-055", slug: `papi055-${ws}` });
    const [u] = await db.insert(schema.users).values({ email: `papi055-${ws.slice(0, 8)}@test.com` }).returning();
    users.push(u!.id);
    await db.insert(schema.workspaceMembers).values({ workspaceId: ws, userId: u!.id, role: "owner" });
    await db.insert(schema.workspaceApiSettings).values({ workspaceId: ws, addonEnabled: true });
    await postCreditTransaction(db, { workspaceId: ws, amount: 100, kind: "purchase", action: "test" });
    const mk = (type: "live" | "test", scopes: string[]) =>
      createPublicApiKey(db, { pepper: PEPPER, maxActiveKeys: 10 }, { workspaceId: ws, userId: u!.id }, { name: type, type, scopes });
    return {
      ws,
      key: (await mk("live", ["contacts:reveal"])).key,
      testKey: (await mk("test", ["contacts:reveal"])).key,
      narrowKey: (await mk("live", ["people:read"])).key,
    };
  }
  const find = (key: string, body: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/api/public/v1/contacts/email/find",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": randomUUID() },
      payload: JSON.stringify(body),
    });
  const balance = async (ws: string) => (await availableCredits(db, ws)).balance;
  const costRows = async (ws: string) => db.select().from(schema.providerCostEvents).where(eq(schema.providerCostEvents.workspaceId, ws));

  beforeAll(async () => {
    Object.assign(A, await workspace());
    Object.assign(B, await workspace());
    const engine = { enrich: async (input: EnrichmentInput) => (calls.push(input), waterfall(input)) } as unknown as EnrichmentEngine;
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
      endpoints: [createEmailFindEndpoint({ env, db, resolveEngine: async () => engine }) as never],
    });
    await app.ready();
  });

  beforeEach(async () => {
    waterfall = nothing;
    calls.length = 0;
    osGet.mockReset();
    osGet.mockResolvedValue(null);
    for (const ws of [A.ws, B.ws]) await db.delete(schema.apiDatumCache).where(eq(schema.apiDatumCache.workspaceId, ws));
  });

  afterAll(async () => {
    await app.close();
    for (const ws of [A.ws, B.ws]) await db.delete(schema.providerCostEvents).where(eq(schema.providerCostEvents.workspaceId, ws));
    for (const ws of [A.ws, B.ws]) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, ws));
    for (const u of users) await db.delete(schema.users).where(eq(schema.users.id, u));
    await sql.end();
  });

  it("finds a verified email by name and domain, charges contacts.email_find, records provider cost, never names a provider", async () => {
    waterfall = found("Ada@Acme.com");
    const before = await balance(A.ws);
    const res = await find(A.key, { full_name: "Ada Lovelace", company_domain: "https://www.acme.com" });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data).toMatchObject({ email: "ada@acme.com", status: "valid", person: { full_name: "Ada Lovelace", company_domain: "acme.com" } });
    expect(data.person.id).toMatch(/^per_/);
    expect(data.provenance.source_class).toBe("external");
    expect(Date.parse(data.provenance.expires_at) - Date.parse(data.provenance.retrieved_at)).toBe(90 * 86_400_000);
    expect(res.headers["x-credits-charged"]).toBe("1");
    expect(await balance(A.ws)).toBe(before - 1);
    expect(calls[0]).toMatchObject({ fullName: "Ada Lovelace", companyDomain: "acme.com", fields: ["email", "validation"] });
    for (const leak of ["hunter", "zerobounce"]) expect(res.body.toLowerCase()).not.toContain(leak);
    expect(res.body).not.toMatch(UUID_RE);
    const costs = await costRows(A.ws);
    expect(costs.length).toBeGreaterThanOrEqual(2);
    expect(costs.every((c) => c.apiKeyId)).toBe(true);
  });

  it("returns the same email free within 30 days without running the waterfall again", async () => {
    waterfall = found("ada@acme.com");
    expect((await find(A.key, { full_name: "Ada Lovelace", company_domain: "acme.com" })).headers["x-credits-charged"]).toBe("1");
    calls.length = 0;
    const again = await find(A.key, { full_name: "Ada Lovelace", company_domain: "acme.com" });
    expect(again.headers["x-credits-charged"]).toBe("0");
    expect(again.json().data.email).toBe("ada@acme.com");
    expect(calls).toHaveLength(0);
    // Another workspace pays for its own find.
    expect((await find(B.key, { full_name: "Ada Lovelace", company_domain: "acme.com" })).headers["x-credits-charged"]).toBe("1");
  });

  it("takes a person_id from search or lookup and uses the index profile", async () => {
    const prospectId = randomBytes(32).toString("hex");
    osGet.mockImplementation(async (_c: unknown, id: string) =>
      id === prospectId ? { prospectId, companyId: "c", fullName: "Grace Hopper", companyDomain: "navy.mil", companyName: "Navy", linkedinUrl: "https://linkedin.com/in/grace" } : null
    );
    waterfall = found("grace@navy.mil");
    const pid = codec.encode("person", prospectId);
    const res = await find(A.key, { person_id: pid });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.person).toEqual({ id: pid, full_name: "Grace Hopper", company_domain: "navy.mil" });
    expect(calls[0]).toMatchObject({ prospectId, fullName: "Grace Hopper", companyDomain: "navy.mil", linkedinUrl: "https://linkedin.com/in/grace" });
  });

  it("charges nothing when no email is found, it is not verified valid, the person is unknown, or providers are down", async () => {
    const before = await balance(A.ws);
    waterfall = nothing;
    expect((await find(A.key, { full_name: "No One", company_domain: "acme.com" })).statusCode).toBe(404);
    waterfall = found("maybe@acme.com", "catch_all");
    expect((await find(A.key, { full_name: "Maybe Person", company_domain: "acme.com" })).statusCode).toBe(404);
    waterfall = found("x@acme.com");
    expect((await find(A.key, { person_id: codec.encode("person", "unknown") })).statusCode).toBe(404);
    expect((await find(A.key, { person_id: "per_forged" })).statusCode).toBe(404);
    waterfall = allFailed;
    const down = await find(A.key, { full_name: "Down Person", company_domain: "acme.com" });
    expect(down.statusCode).toBe(503);
    expect(down.json().error.code).toBe("upstream_unavailable");
    expect(await balance(A.ws)).toBe(before);
  });

  it("never returns an email the workspace suppressed, even from the 30-day cache", async () => {
    waterfall = found("linus@acme.com");
    expect((await find(A.key, { full_name: "Linus T", company_domain: "acme.com" })).statusCode).toBe(200);
    await db.insert(schema.suppressions).values({ workspaceId: A.ws, email: "LINUS@acme.com", reason: "unsubscribed" });
    try {
      const before = await balance(A.ws);
      expect((await find(A.key, { full_name: "Linus T", company_domain: "acme.com" })).statusCode).toBe(404);
      await db.delete(schema.apiDatumCache).where(eq(schema.apiDatumCache.workspaceId, A.ws));
      expect((await find(A.key, { full_name: "Linus T", company_domain: "acme.com" })).statusCode).toBe(404);
      expect(await balance(A.ws)).toBe(before);
    } finally {
      await db.delete(schema.suppressions).where(and(eq(schema.suppressions.workspaceId, A.ws), eq(schema.suppressions.email, "LINUS@acme.com")));
    }
  });

  it("validates strictly, needs contacts:reveal, and serves test keys a free fixture", async () => {
    for (const body of [
      {},
      { full_name: "Ada" },
      { company_domain: "acme.com" },
      { person_id: "per_x", full_name: "Ada", company_domain: "acme.com" },
      { full_name: "Ada", company_domain: "not a domain" },
      { full_name: "Ada", company_domain: "acme.com", linkedin_url: "https://linkedin.com/company/acme" },
      { full_name: "Ada", company_domain: "acme.com", workspace_id: B.ws },
    ]) {
      expect((await find(A.key, body)).statusCode, JSON.stringify(body)).toBe(422);
    }
    expect((await find(A.narrowKey, { full_name: "Ada", company_domain: "acme.com" })).statusCode).toBe(403);
    const before = await balance(A.ws);
    const fx = await find(A.testKey, { full_name: "Ada", company_domain: "acme.com" });
    expect(fx.statusCode).toBe(200);
    expect(fx.json().data.email).toBe("ada@example.com");
    expect(calls).toHaveLength(0);
    expect(await balance(A.ws)).toBe(before);
  });
});
