import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { API_PRICE_OPERATIONS } from "@skout/shared";
import { ApiPricingService, PRICE_CACHE_TTL_MS, codeDefaultPrices } from "./api-pricing.service.js";
import { SCORE_CREDIT_COST } from "./enrichment/service.js";

describe("code default prices (PRD §8)", () => {
  it("match the PRD starting defaults", () => {
    expect(codeDefaultPrices({ searchCreditCost: 1 })).toEqual({
      "search.index_page": 1,
      "search.vendor_result": 1,
      "people.lookup": 1,
      "companies.lookup": 1,
      "companies.jobs": 1,
      "contacts.email_find": 1,
      "contacts.phone_find": 10,
      "emails.verify": 0,
      "scores.score": SCORE_CREDIT_COST,
    });
    expect(codeDefaultPrices({ searchCreditCost: 3 })["search.index_page"]).toBe(3);
  });
});

const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("price resolver (PAPI-030, Postgres)", () => {
  const { db, sql } = createDb(url as string);
  let platformWs: string;
  let customerWs: string;
  let staffId: string;
  let now = Date.now();
  const clock = () => now;
  const cfg = () => ({ platformWorkspaceId: platformWs, searchCreditCost: 1 });
  const ctx = () => ({ workspaceId: platformWs, userId: staffId, requestId: `req_${randomUUID()}` });

  beforeAll(async () => {
    platformWs = randomUUID();
    customerWs = randomUUID();
    await db.insert(schema.workspaces).values([
      { id: platformWs, name: "Skout CustomerOps", slug: `papi030-ops-${platformWs}` },
      { id: customerWs, name: "Customer", slug: `papi030-cust-${customerWs}` },
    ]);
    const [u] = await db.insert(schema.users).values({ email: `papi030-${platformWs.slice(0, 8)}@test.com` }).returning();
    staffId = u!.id;
  });

  afterAll(async () => {
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, customerWs));
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, platformWs));
    await db.delete(schema.users).where(eq(schema.users.id, staffId));
    await sql.end();
  });

  it("reads all three levels: workspace override, then global default, then code default", async () => {
    const svc = new ApiPricingService(db, cfg(), clock);
    const start = await svc.priceList(customerWs);
    for (const op of API_PRICE_OPERATIONS) expect(start[op].source).toBe("default");
    expect(start["contacts.phone_find"]).toEqual({ operation: "contacts.phone_find", credits: 10, source: "default" });

    await svc.setGlobalPrices(ctx(), { "contacts.phone_find": 8, "emails.verify": 1 }, "launch pricing");
    expect(await svc.priceFor(customerWs, "contacts.phone_find")).toEqual({ operation: "contacts.phone_find", credits: 8, source: "global" });
    expect((await svc.priceFor(customerWs, "emails.verify")).credits).toBe(1);
    expect((await svc.priceFor(customerWs, "people.lookup")).source).toBe("default");

    await svc.setWorkspacePrice({ workspaceId: platformWs, staffId }, customerWs, "contacts.phone_find", 5, "enterprise deal");
    expect(await svc.priceFor(customerWs, "contacts.phone_find")).toEqual({ operation: "contacts.phone_find", credits: 5, source: "workspace" });

    await svc.setWorkspacePrice({ workspaceId: platformWs, staffId }, customerWs, "contacts.phone_find", null, "deal ended");
    expect((await svc.priceFor(customerWs, "contacts.phone_find")).source).toBe("global");
    expect(await svc.priceSnapshot(customerWs, ["contacts.phone_find", "emails.verify"])).toEqual({ "contacts.phone_find": 8, "emails.verify": 1 });
  });

  it("follows the app's own scoring price unless the API price is overridden", async () => {
    const svc = new ApiPricingService(db, cfg(), clock);
    await db.insert(schema.entitlements).values({ workspaceId: customerWs, key: "enrichment.score_credit_cost", value: 4, source: "test" });
    expect(await svc.priceFor(customerWs, "scores.score")).toEqual({ operation: "scores.score", credits: 4, source: "workspace" });
    await svc.setWorkspacePrice({ workspaceId: platformWs, staffId }, customerWs, "scores.score", 3, "api discount");
    expect((await svc.priceFor(customerWs, "scores.score")).credits).toBe(3);
    await svc.setWorkspacePrice({ workspaceId: platformWs, staffId }, customerWs, "scores.score", null, "reset");
    await db.delete(schema.entitlements).where(and(eq(schema.entitlements.workspaceId, customerWs), eq(schema.entitlements.key, "enrichment.score_credit_cost")));
  });

  it("applies a change made on another instance to new requests within 60 seconds, with no deploy", async () => {
    const serverA = new ApiPricingService(db, cfg(), clock);
    const serverB = new ApiPricingService(db, cfg(), clock);
    expect((await serverA.priceFor(customerWs, "people.lookup")).credits).toBe(1);
    await serverB.setWorkspacePrice({ workspaceId: platformWs, staffId }, customerWs, "people.lookup", 2, "price rise");
    expect((await serverB.priceFor(customerWs, "people.lookup")).credits).toBe(2); // the changing instance: at once
    expect((await serverA.priceFor(customerWs, "people.lookup")).credits).toBe(1); // still cached on A
    now += PRICE_CACHE_TTL_MS - 1000;
    expect((await serverA.priceFor(customerWs, "people.lookup")).credits).toBe(1);
    now += 1000;
    expect((await serverA.priceFor(customerWs, "people.lookup")).credits).toBe(2); // within 60 s

    await serverB.setGlobalPrices(ctx(), { "contacts.phone_find": 9 }, "global change");
    now += PRICE_CACHE_TTL_MS;
    expect((await serverA.priceFor(customerWs, "contacts.phone_find")).credits).toBe(9);
    await serverB.setWorkspacePrice({ workspaceId: platformWs, staffId }, customerWs, "people.lookup", null, "reset");
  });

  it("writes an audit row for each change, with who, the old value and the new value", async () => {
    const svc = new ApiPricingService(db, cfg(), clock);
    await svc.setWorkspacePrice({ workspaceId: platformWs, staffId, requestId: "req_audit" }, customerWs, "companies.jobs", 3, "audit test");
    await svc.setWorkspacePrice({ workspaceId: platformWs, staffId }, customerWs, "companies.jobs", 4, "audit test 2");
    const ws = await db
      .select()
      .from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.workspaceId, customerWs), eq(schema.auditLogs.action, "api_price.workspace_override_set")));
    const jobs = ws.filter((a) => (a.afterState as { operation: string }).operation === "companies.jobs");
    expect(jobs.map((a) => [(a.beforeState as { credits: number | null }).credits, (a.afterState as { credits: number }).credits])).toEqual(
      expect.arrayContaining([
        [null, 3],
        [3, 4],
      ])
    );
    expect(jobs.every((a) => a.actorRef === staffId && a.reason && a.createdAt instanceof Date)).toBe(true);

    const global = await db
      .select()
      .from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.workspaceId, platformWs), eq(schema.auditLogs.action, "admin_config.saved")));
    const last = global.at(-1)!;
    expect(last.afterState).toMatchObject({ kind: "api_price", key: "default", value: { prices: { "contacts.phone_find": 9 } } });
    expect(last.beforeState).toMatchObject({ value: { prices: { "contacts.phone_find": 8 } } });
  });

  it("rejects bad input and global changes from any other workspace", async () => {
    const svc = new ApiPricingService(db, cfg(), clock);
    const actor = { workspaceId: platformWs, staffId };
    await expect(svc.setWorkspacePrice(actor, customerWs, "made.up", 1, "x")).rejects.toMatchObject({ statusCode: 422 });
    await expect(svc.setWorkspacePrice(actor, customerWs, "people.lookup", -1, "x")).rejects.toMatchObject({ statusCode: 422 });
    await expect(svc.setWorkspacePrice(actor, customerWs, "people.lookup", 1.5, "x")).rejects.toMatchObject({ statusCode: 422 });
    await expect(svc.setWorkspacePrice(actor, customerWs, "people.lookup", 1, " ")).rejects.toMatchObject({ statusCode: 422 });
    await expect(svc.setGlobalPrices({ ...ctx(), workspaceId: customerWs }, { "people.lookup": 1 }, "x")).rejects.toMatchObject({ statusCode: 403 });
    await expect(svc.setGlobalPrices(ctx(), { "people.lookup": -2 }, "x")).rejects.toThrow();
    await expect(new ApiPricingService(db, { platformWorkspaceId: undefined, searchCreditCost: 1 }).setGlobalPrices(ctx(), {}, "x")).rejects.toMatchObject({ statusCode: 503 });
    // A malformed stored override is ignored, never charged.
    await db.insert(schema.entitlements).values({ workspaceId: customerWs, key: "api.price.companies.lookup", value: "free", source: "test" });
    expect((await new ApiPricingService(db, cfg(), clock).priceFor(customerWs, "companies.lookup")).source).not.toBe("workspace");
  });
});
