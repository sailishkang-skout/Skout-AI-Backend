import { describe, expect, it } from "vitest";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";

describe("workspace routes", () => {
  it("returns the workspace ICP payload from /api/v1/workspace/icp", async () => {
    const config = loadEnv();
    const app = await buildApp({ ...config, LOG_LEVEL: "fatal" });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/workspace/icp",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      workspaceId: "00000000-0000-4000-8000-000000000001",
      config: { onboarding: { completedAt: expect.any(String) } },
    });

    await app.close();
  });
});
