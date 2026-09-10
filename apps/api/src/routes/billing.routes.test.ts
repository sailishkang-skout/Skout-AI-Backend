import { describe, expect, it } from "vitest";
import { schema } from "@skout/db";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";

async function buildTestApp() {
  const config = loadEnv();
  return buildApp({
    ...config,
    CLERK_SECRET_KEY: undefined,
    LOG_LEVEL: "fatal",
    OPENSEARCH_URL: undefined,
  });
}

function asUser(email: string) {
  return { "x-stub-user-email": email };
}

async function resolveWorkspaceId(app: Awaited<ReturnType<typeof buildTestApp>>, email: string) {
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/workspaces/current",
    headers: asUser(email),
  });
  return (res.json() as { data: { id: string } }).data.id;
}

/**
 * Seeds a paid invoice directly rather than through POST /billing/razorpay/order — that route
 * calls out to the real Razorpay API (test keys are configured in .env), which this suite
 * should not depend on for a tenant-isolation check.
 */
async function seedPaidOrder(app: Awaited<ReturnType<typeof buildTestApp>>, workspaceId: string) {
  if (!app.db) return null;
  const [row] = await app.db
    .insert(schema.paymentOrders)
    .values({
      workspaceId,
      providerOrderId: `order_test_${Math.random().toString(36).slice(2)}`,
      packId: "growth",
      amountPaise: 149900,
      credits: 2000,
      status: "paid",
      paidAt: new Date(),
    })
    .returning();
  return row ?? null;
}

describe("Billing routes", () => {
  it("lists a workspace's own paid invoice", async () => {
    const app = await buildTestApp();
    const workspaceId = await resolveWorkspaceId(app, "billing-basic@test.com");
    const order = await seedPaidOrder(app, workspaceId);
    if (!order) {
      await app.close();
      return;
    }

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/billing/invoices/${order.id}`,
      headers: asUser("billing-basic@test.com"),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { id: string; credits: number } };
    expect(body.data.id).toBe(order.id);
    expect(body.data.credits).toBe(2000);
    await app.close();
  });

  describe("workspace isolation", () => {
    it("a paid invoice in one workspace is not fetchable or listed from another", async () => {
      const app = await buildTestApp();
      const workspaceIdA = await resolveWorkspaceId(app, "billing-iso-userA@test.com");
      const order = await seedPaidOrder(app, workspaceIdA);
      if (!order) {
        await app.close();
        return;
      }

      const crossGet = await app.inject({
        method: "GET",
        url: `/api/v1/billing/invoices/${order.id}`,
        headers: asUser("billing-iso-userB@test.com"),
      });
      expect(crossGet.statusCode).toBe(404);

      const crossList = await app.inject({
        method: "GET",
        url: "/api/v1/billing/invoices",
        headers: asUser("billing-iso-userB@test.com"),
      });
      const crossListBody = crossList.json() as { data: { invoices: Array<{ id: string }> } };
      expect(crossListBody.data.invoices.some((i) => i.id === order.id)).toBe(false);

      // Still fetchable from the owning workspace.
      const ownGet = await app.inject({
        method: "GET",
        url: `/api/v1/billing/invoices/${order.id}`,
        headers: asUser("billing-iso-userA@test.com"),
      });
      expect(ownGet.statusCode).toBe(200);

      await app.close();
    });
  });
});
