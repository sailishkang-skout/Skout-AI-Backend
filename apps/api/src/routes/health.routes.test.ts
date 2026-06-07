import { describe, expect, it } from "vitest";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";

describe("health routes", () => {
  it("returns ok from /api/v1/health", async () => {
    const config = loadEnv();
    const app = await buildApp({ ...config, LOG_LEVEL: "fatal" });

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
});
