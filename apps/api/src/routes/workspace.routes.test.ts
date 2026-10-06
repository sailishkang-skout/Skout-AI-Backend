import { describe, expect, it } from "vitest";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { isTeamsWorkflowWebhookUrl } from "./workspace.routes.js";

async function buildTestApp() {
  // These route tests authenticate with the stub header. A local .env with AUTH_MODE set would
  // disable stub mode (and the 401s follow), so pin stub mode for the config load.
  delete process.env.AUTH_MODE;
  process.env.AUTH_STUB = "true";
  process.env.CLERK_SECRET_KEY = "";
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

function json(email: string) {
  return { ...asUser(email), "content-type": "application/json" };
}

describe("isTeamsWorkflowWebhookUrl", () => {
  it.each([
    "https://prod-01.powerplatform.com/workflows/trigger?sig=secret",
    "https://prod-01.logic.azure.com/workflows/trigger?sig=secret",
    "https://outlook.office.com/webhook/endpoint",
  ])("accepts an HTTPS Microsoft webhook URL (%s)", (url) => {
    expect(isTeamsWorkflowWebhookUrl(url)).toBe(true);
  });

  it.each([
    "http://prod-01.powerplatform.com/workflows/trigger",
    "https://attacker.example/workflows/trigger",
    "https://powerplatform.com.attacker.example/workflows/trigger",
    "https://user:password@prod-01.powerplatform.com/workflows/trigger",
    "https://prod-01.powerplatform.com:8443/workflows/trigger",
  ])("rejects an unsafe or unsupported webhook URL (%s)", (url) => {
    expect(isTeamsWorkflowWebhookUrl(url)).toBe(false);
  });
});

describe("PUT /workspaces/current/deal-promotion-threshold", () => {
  it("rejects an out-of-range threshold", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/workspaces/current/deal-promotion-threshold",
      headers: json("threshold-range@test.com"),
      payload: { threshold: 150 },
    });
    if (res.statusCode === 503) {
      await app.close();
      return;
    }
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a non-numeric threshold", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/workspaces/current/deal-promotion-threshold",
      headers: json("threshold-type@test.com"),
      payload: { threshold: "high" },
    });
    if (res.statusCode === 503) {
      await app.close();
      return;
    }
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("updates the threshold for the caller's workspace", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/workspaces/current/deal-promotion-threshold",
      headers: json("threshold-update@test.com"),
      payload: { threshold: 65 },
    });
    if (res.statusCode === 503) {
      await app.close();
      return;
    }
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { dealPromotionThreshold: number } };
    expect(body.data.dealPromotionThreshold).toBe(65);
    await app.close();
  });
});
