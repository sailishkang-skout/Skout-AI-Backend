import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createHmac } from "node:crypto";
import { billingRoutes, unsignedRazorpayWebhookAllowed } from "./billing.routes.js";

/**
 * COPS-03 fix: the Razorpay webhook must fail closed. Without RAZORPAY_WEBHOOK_SECRET it used to
 * accept any body, in every environment. Unsigned webhooks are now a local-development convenience only.
 */
const EVENT = { event: "payment.captured", payload: { payment: { entity: { id: "pay_x", order_id: "order_unknown" } } } };

async function appWith(config: Record<string, unknown>): Promise<FastifyInstance> {
  const app = Fastify();
  // The handler only reaches the database for an order it can match; this event matches none.
  const noRows = () => {
    const q: any = {};
    for (const m of ["from", "where", "limit", "set", "values", "returning", "onConflictDoNothing"]) q[m] = () => q;
    q.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve);
    return q;
  };
  const db = { select: noRows, update: noRows, insert: noRows, transaction: async (fn: (tx: unknown) => unknown) => fn(db) };
  app.decorate("db", db as never);
  app.decorate("config", config as never);
  await app.register(billingRoutes);
  await app.ready();
  return app;
}

const post = (app: FastifyInstance, signature?: string) =>
  app.inject({
    method: "POST",
    url: "/billing/webhooks/razorpay",
    headers: { "content-type": "application/json", ...(signature ? { "x-razorpay-signature": signature } : {}) },
    payload: JSON.stringify(EVENT),
  });

describe("Razorpay billing webhook fails closed", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("allows unsigned webhooks only in development and test", () => {
    expect(unsignedRazorpayWebhookAllowed("development")).toBe(true);
    expect(unsignedRazorpayWebhookAllowed("test")).toBe(true);
    expect(unsignedRazorpayWebhookAllowed("production")).toBe(false);
    expect(unsignedRazorpayWebhookAllowed(undefined)).toBe(false);
    expect(unsignedRazorpayWebhookAllowed("staging")).toBe(false);
  });

  it("refuses every webhook in production when the secret is not configured", async () => {
    app = await appWith({ NODE_ENV: "production" });
    const res = await post(app);
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain("not configured");
    // A signature made with a guessed secret is refused too: there is nothing to verify it against.
    expect((await post(app, "0".repeat(64))).statusCode).toBe(503);
  });

  it("with the secret set, a missing or wrong signature is refused in every environment", async () => {
    for (const NODE_ENV of ["production", "development"]) {
      app = await appWith({ NODE_ENV, RAZORPAY_WEBHOOK_SECRET: "whsec_test" });
      expect((await post(app)).statusCode).toBe(400);
      expect((await post(app, "0".repeat(64))).statusCode).toBe(400);
      const good = createHmac("sha256", "whsec_test").update(JSON.stringify(EVENT)).digest("hex");
      expect((await post(app, good)).statusCode).not.toBe(400);
      expect((await post(app, good)).statusCode).not.toBe(503);
      await app.close();
      app = undefined;
    }
  });

  it("still accepts an unsigned webhook on a developer machine", async () => {
    app = await appWith({ NODE_ENV: "development" });
    const res = await post(app);
    expect(res.statusCode).not.toBe(503);
    expect(res.statusCode).not.toBe(400);
  });
});
