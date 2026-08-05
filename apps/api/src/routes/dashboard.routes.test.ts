import { describe, expect, it } from "vitest";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";

describe("dashboard routes", () => {
  it("returns the dashboard summary from /api/v1/dashboard/summary", async () => {
    const config = loadEnv();
    const app = await buildApp({ ...config, LOG_LEVEL: "fatal" });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/summary",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        workspaceName: expect.any(String),
        credits: expect.any(Number),
        listCount: expect.any(Number),
        totalProspectsInLists: expect.any(Number),
        icpConfigured: true,
        recentJobs: [],
      },
    });

    await app.close();
  });
});
