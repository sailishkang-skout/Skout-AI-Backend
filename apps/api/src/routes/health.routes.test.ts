import { describe, expect, it } from "vitest";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";

describe("health routes", () => {
  it("returns ok from /api/v1/health", async () => {
    const config = loadEnv();
    const app = await buildApp({
      ...config,
      LOG_LEVEL: "fatal",
      CLERK_SECRET_KEY: undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      service: "skout-api",
    });

    await app.close();
  });

  it("returns SLO targets from /api/v1/slo", async () => {
    const config = loadEnv();
    const app = await buildApp({
      ...config,
      LOG_LEVEL: "fatal",
      CLERK_SECRET_KEY: undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/slo",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      service: "skout-api",
      targets: {
        health: { availability: 0.999, p95Ms: 100 },
      },
    });

    await app.close();
  });
});
