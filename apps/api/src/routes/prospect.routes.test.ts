import { describe, expect, it } from "vitest";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";

describe("prospect / enrichment routes", () => {
  it("returns an empty enrichment jobs list from /api/v1/enrichment/jobs", async () => {
    const config = loadEnv();
    const app = await buildApp({ ...config, LOG_LEVEL: "fatal" });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/enrichment/jobs",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      workspaceId: "00000000-0000-4000-8000-000000000001",
      data: [],
      total: 0,
    });

    await app.close();
  });

  it("returns 404 for a missing enrichment job from /api/v1/enrichment/jobs/:id", async () => {
    const config = loadEnv();
    const app = await buildApp({ ...config, LOG_LEVEL: "fatal" });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/enrichment/jobs/nope",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "Job not found" });

    await app.close();
  });
});
