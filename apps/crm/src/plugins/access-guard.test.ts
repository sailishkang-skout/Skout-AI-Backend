import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { WorkspaceAccessState } from "@skout/auth";
import { PRODUCT_FEATURES } from "@skout/shared";
import { crmAccessGuard, earlyAccessGateEnabled } from "./access-guard.js";

const allOn = Object.fromEntries(PRODUCT_FEATURES.map((f) => [f, true])) as WorkspaceAccessState["features"];

async function appFor(state: WorkspaceAccessState | null, gate = true) {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    if (state) request.workspaceId = "11111111-2222-4333-8444-555555555555";
  });
  app.addHook("preHandler", crmAccessGuard(async () => state!, gate));
  app.get("/crm/v1/companies", async () => ({ data: [] }));
  app.get("/health", async () => ({ ok: true }));
  return app;
}

describe("CRM early access guard", () => {
  it("refuses a pending workspace", async () => {
    const app = await appFor({ status: "pending", features: allOn });
    const res = await app.inject({ method: "GET", url: "/crm/v1/companies" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "access_pending" });
  });

  it("refuses a rejected workspace", async () => {
    const app = await appFor({ status: "rejected", features: allOn });
    const res = await app.inject({ method: "GET", url: "/crm/v1/companies" });
    expect(res.json()).toMatchObject({ code: "access_rejected" });
  });

  it("refuses when the crm feature is off", async () => {
    const app = await appFor({ status: "active", features: { ...allOn, crm: false } });
    const res = await app.inject({ method: "GET", url: "/crm/v1/companies" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "feature_disabled", feature: "crm" });
  });

  it("lets an active workspace through", async () => {
    const app = await appFor({ status: "active", features: allOn });
    expect((await app.inject({ method: "GET", url: "/crm/v1/companies" })).statusCode).toBe(200);
  });

  it("with the gate off a pending workspace passes", async () => {
    const app = await appFor({ status: "pending", features: allOn }, false);
    expect((await app.inject({ method: "GET", url: "/crm/v1/companies" })).statusCode).toBe(200);
  });

  it("passes requests without a workspace", async () => {
    const app = await appFor(null);
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });

  it("defaults the gate on in production only", () => {
    expect(earlyAccessGateEnabled({ NODE_ENV: "production" })).toBe(true);
    expect(earlyAccessGateEnabled({ NODE_ENV: "development" })).toBe(false);
    expect(earlyAccessGateEnabled({ NODE_ENV: "production", EARLY_ACCESS_GATE_ENABLED: "false" })).toBe(false);
  });
});
