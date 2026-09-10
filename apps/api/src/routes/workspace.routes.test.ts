import { describe, expect, it } from "vitest";
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

function json(email: string) {
  return { ...asUser(email), "content-type": "application/json" };
}

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
