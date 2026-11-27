// cSpell:ignore wiza opensearch
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const osSearch = vi.fn();
const bulkCreate = vi.fn();
vi.mock("@skout/opensearch", async (orig) => ({
  ...(await orig<typeof import("@skout/opensearch")>()),
  searchProspects: (...a: unknown[]) => osSearch(...a),
  bulkCreateProspects: (...a: unknown[]) => bulkCreate(...a),
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
import { createPeopleSearchEndpoint } from "./people-search.js";

/** PAPI-051: POST /people/search on real Postgres, with OpenSearch and the vendor mocked. */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const PEPPER = randomBytes(32).toString("base64");
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const env = { OPENSEARCH_URL: "https://os.test", WIZA_API_KEY: "w", WIZA_BASE_URL: "https://wiza.test", DEMO_CORPUS_SIZE: 10 } as never;
const doc = (name: string, extra: Record<string, unknown> = {}) => ({
  prospectId: randomBytes(32).toString("hex"),
  companyId: randomUUID(),
  fullName: name,
  title: "CTO",
  companyDomain: "acme.com",
  companyName: "Acme",
  country: "IN",
  updatedAt: "2026-01-01T00:00:00Z",
  dataSource: "vendor",
  ...extra,
});
const adaId = vendorProspectId({ vendor: "wiza", fullName: "Ada L", linkedinUrl: "https://linkedin.com/in/ada" });
const adaDoc = () => ({ ...doc("Ada L"), prospectId: adaId });
const wiza = (profiles: { full_name: string; linkedin_url: string }[]) => async () =>
  new Response(JSON.stringify({ data: { total: profiles.length, profiles } }), { status: 200 });

maybe("POST /people/search (PAPI-051)", () => {
  const { db, sql } = createDb(url as string);
  let app: FastifyInstance;
  const users: string[] = [];
  const A = { ws: "", key: "", testKey: "" };
  const B = { ws: "", key: "" };

  async function workspace(prices: Record<string, number>) {
    const ws = randomUUID();
    await db.insert(schema.workspaces).values({ id: ws, name: "PAPI-051", slug: `papi051-${ws}` });
    const [u] = await db.insert(schema.users).values({ email: `papi051-${ws.slice(0, 8)}@test.com`, isActive: true }).returning();
    users.push(u!.id);
    await db.insert(schema.workspaceMembers).values({ workspaceId: ws, userId: u!.id, role: "owner" });
    await db.insert(schema.workspaceApiSettings).values({ workspaceId: ws, addonEnabled: true });
    for (const [op, v] of Object.entries(prices)) await db.insert(schema.entitlements).values({ workspaceId: ws, key: `api.price.${op}`, value: v, source: "test" });
    await postCreditTransaction(db, { workspaceId: ws, amount: 100, kind: "purchase", action: "test" });
    const mk = (type: "live" | "test") =>
      createPublicApiKey(db, { pepper: PEPPER, maxActiveKeys: 10 }, { workspaceId: ws, userId: u!.id }, { name: type, type, scopes: ["search:read"] });
    return { ws, key: (await mk("live")).key, testKey: (await mk("test")).key };
  }
  const search = (key: string, body: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/api/public/v1/people/search",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": randomUUID() },
      payload: JSON.stringify(body),
    });
  const balance = async (ws: string) => (await availableCredits(db, ws)).balance;

  beforeAll(async () => {
    Object.assign(A, await workspace({ "search.index_page": 2, "search.vendor_result": 3 }));
    Object.assign(B, await workspace({}));
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
        ids: createPublicIdCodec(PEPPER),
      },
      endpoints: [createPeopleSearchEndpoint({ env, db }) as never],
    });
    await app.ready();
  });

  beforeEach(() => {
    osSearch.mockReset();
    bulkCreate.mockReset();
    bulkCreate.mockResolvedValue({ created: 1, existing: 0, failed: 0 });
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await app.close();
    for (const ws of [A.ws, B.ws]) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, ws));
    for (const u of users) await db.delete(schema.users).where(eq(schema.users.id, u));
    await sql.end();
  });

  it("index-only page: charges search.index_page, says skout_index, and leaks no ids or vendor names", async () => {
    vi.stubGlobal("fetch", vi.fn());
    osSearch.mockResolvedValue({ hits: [doc("Grace H"), doc("Alan T")], total: 2 });
    const before = await balance(A.ws);
    const res = await search(A.key, { job_title: "CTO", country: "IN", limit: 2 });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.people).toHaveLength(2);
    expect(body.data.people[0]).toMatchObject({ id: expect.stringMatching(/^per_/), company: { id: expect.stringMatching(/^com_/), name: "Acme" }, data_origin: "skout_index" });
    expect(res.headers["x-credits-charged"]).toBe("2");
    expect(await balance(A.ws)).toBe(before - 2);
    expect(res.body).not.toMatch(UUID_RE);
    expect(res.body.toLowerCase()).not.toContain("wiza");
  });

  it("mixed page: page price plus each vendor result; the same search the next day costs only the index price", async () => {
    vi.stubGlobal("fetch", vi.fn(wiza([{ full_name: "Ada L", linkedin_url: "https://linkedin.com/in/ada" }])));
    const stored = doc("Grace H");
    osSearch.mockResolvedValueOnce({ hits: [stored], total: 1 }).mockResolvedValueOnce({ hits: [stored, adaDoc()], total: 2 });
    const filters = { job_title: "VP Sales", limit: 2 };
    const first = await search(A.key, filters);
    expect(first.statusCode).toBe(200);
    expect(first.json().data.people.map((p: { data_origin: string }) => p.data_origin)).toEqual(["skout_index", "external"]);
    expect(first.headers["x-credits-charged"]).toBe(String(2 + 3));
    expect(first.body.toLowerCase()).not.toContain("wiza");

    // The next day (cache window over), Ada is in the index: an index-only page at the index price.
    await db
      .update(schema.apiDatumCache)
      .set({ deliveredAt: new Date(Date.now() - 25 * 3_600_000) })
      .where(and(eq(schema.apiDatumCache.workspaceId, A.ws), eq(schema.apiDatumCache.datumType, "search_page")));
    vi.stubGlobal("fetch", vi.fn());
    osSearch.mockResolvedValue({ hits: [stored, adaDoc()], total: 2 });
    const nextDay = await search(A.key, filters);
    expect(nextDay.headers["x-credits-charged"]).toBe("2");
    expect(nextDay.json().data.people.map((p: { data_origin: string }) => p.data_origin)).toEqual(["skout_index", "skout_index"]);
  });

  it("empty page: charges nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(wiza([])));
    osSearch.mockResolvedValue({ hits: [], total: 0 });
    const before = await balance(A.ws);
    const res = await search(A.key, { job_title: "Chief Unicorn Officer" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ people: [], has_more: false, next_cursor: null });
    expect(res.headers["x-credits-charged"]).toBe("0");
    expect(await balance(A.ws)).toBe(before);
  });

  it("a repeat of the same page within 24 hours is free and doesn't search again", async () => {
    vi.stubGlobal("fetch", vi.fn());
    osSearch.mockResolvedValue({ hits: [doc("Linus T")], total: 1 });
    const first = await search(A.key, { job_title: "Kernel Lead", limit: 1 });
    expect(first.headers["x-credits-charged"]).toBe("2");
    osSearch.mockClear();
    const again = await search(A.key, { limit: 1, job_title: "Kernel Lead" });
    expect(again.headers["x-credits-charged"]).toBe("0");
    expect(again.json()).toEqual(first.json());
    expect(osSearch).not.toHaveBeenCalled();
  });

  it("charges nothing when the search fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("forbidden", { status: 403 })));
    osSearch.mockResolvedValue({ hits: [], total: 0 });
    const before = await balance(A.ws);
    const res = await search(A.key, { job_title: "Anyone" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("upstream_unavailable");
    expect(await balance(A.ws)).toBe(before);
    const held = await db.select().from(schema.creditHolds).where(and(eq(schema.creditHolds.workspaceId, A.ws), eq(schema.creditHolds.status, "held")));
    expect(held).toHaveLength(0);
  });

  it("keeps workspaces apart: another workspace's cached page isn't free, uses its own prices, and workspace_id is refused", async () => {
    vi.stubGlobal("fetch", vi.fn());
    osSearch.mockResolvedValue({ hits: [doc("Margaret H")], total: 1 });
    expect((await search(A.key, { job_title: "Flight Software", limit: 1 })).headers["x-credits-charged"]).toBe("2");
    const forB = await search(B.key, { job_title: "Flight Software", limit: 1 });
    expect(forB.headers["x-credits-charged"]).toBe("1"); // B's default price, not free from A's cache
    const bad = await search(B.key, { job_title: "Flight Software", workspace_id: A.ws });
    expect(bad.statusCode).toBe(422);
  });

  it("never returns someone whose email the workspace has suppressed", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const optedOut = doc("Opted Out", { email: "gone@example.com" });
    const fine = doc("Still Here", { email: "here@example.com" });
    await db.insert(schema.suppressions).values({ workspaceId: A.ws, email: "GONE@example.com", reason: "unsubscribed" });
    osSearch.mockResolvedValue({ hits: [optedOut, fine], total: 2 });
    const forA = await search(A.key, { job_title: "Privacy Lead", limit: 2 });
    expect(forA.json().data.people.map((p: { full_name: string }) => p.full_name)).toEqual(["Still Here"]);
    osSearch.mockResolvedValue({ hits: [optedOut, fine], total: 2 });
    const forB = await search(B.key, { job_title: "Privacy Lead", limit: 2 });
    expect(forB.json().data.people.map((p: { full_name: string }) => p.full_name)).toEqual(["Opted Out", "Still Here"]);
    expect(forA.body).not.toContain("gone@example.com");
  });

  it("pages with an opaque cursor tied to the search", async () => {
    vi.stubGlobal("fetch", vi.fn());
    osSearch.mockResolvedValue({ hits: [doc("P1"), doc("P2")], total: 5 });
    const page1 = await search(A.key, { job_title: "Data Engineer", limit: 2 });
    expect(page1.json().data).toMatchObject({ has_more: true, next_cursor: expect.stringMatching(/^cur_/) });
    const cursor = page1.json().data.next_cursor;
    osSearch.mockClear();
    osSearch.mockResolvedValue({ hits: [doc("P3"), doc("P4")], total: 5 });
    const page2 = await search(A.key, { job_title: "Data Engineer", limit: 2, cursor });
    expect(page2.statusCode).toBe(200);
    expect(osSearch.mock.calls[0]![2]).toBe(2); // page 2 of the index
    expect((await search(A.key, { job_title: "Designer", limit: 2, cursor })).statusCode).toBe(422);
    expect((await search(A.key, { job_title: "Data Engineer", limit: 2, cursor: "cur_forged" })).statusCode).toBe(422);
  });

  it("validates strictly and needs a filter", async () => {
    expect((await search(A.key, { limit: 5 })).statusCode).toBe(422);
    expect((await search(A.key, { job_title: "CTO", limit: 26 })).statusCode).toBe(422);
    expect((await search(A.key, { job_title: "CTO", jobTitle: "CTO" })).statusCode).toBe(422);
  });

  it("serves test keys deterministic fixture data without searching or charging", async () => {
    const before = await balance(A.ws);
    const res = await search(A.testKey, { job_title: "CTO" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.people[0]).toMatchObject({ full_name: "Ada Lovelace", data_origin: "skout_index" });
    expect(osSearch).not.toHaveBeenCalled();
    expect(await balance(A.ws)).toBe(before);
  });

  it("is unavailable, never demo data, when Skout's index isn't configured", async () => {
    const ep = createPeopleSearchEndpoint({ env: {} as never, db });
    await expect(
      ep.handle({ input: { job_title: "CTO", limit: 25 }, ids: createPublicIdCodec(PEPPER) } as never)
    ).rejects.toMatchObject({ code: "upstream_unavailable" });
  });
});
