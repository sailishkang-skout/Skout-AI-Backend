import { describe, expect, it } from "vitest";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { buildClickUrl, buildOpenPixelUrl } from "../services/tracking.service.js";

async function buildTestApp() {
  const config = loadEnv();
  return buildApp({
    ...config,
    CLERK_SECRET_KEY: undefined,
    LOG_LEVEL: "fatal",
    OPENSEARCH_URL: undefined,
  });
}

describe("GET /api/v1/track/open/:token", () => {
  it("always returns a GIF, even for an invalid token", async () => {
    const app = await buildTestApp();

    const res = await app.inject({ method: "GET", url: "/api/v1/track/open/garbage" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/gif");
    expect(res.rawPayload.subarray(0, 3).toString("ascii")).toBe("GIF");

    await app.close();
  });

  it("returns a GIF for a well-formed token (no DB / unknown enrollment)", async () => {
    const app = await buildTestApp();
    const config = loadEnv();
    const url = buildOpenPixelUrl(config, "00000000-0000-0000-0000-000000000000", "step-1");
    const path = url.replace(/^https?:\/\/[^/]+/, "");

    const res = await app.inject({ method: "GET", url: path });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/gif");

    await app.close();
  });

  it("does not require auth headers (public route)", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/track/open/garbage" });
    expect(res.statusCode).not.toBe(401);
    await app.close();
  });
});

describe("GET /api/v1/track/click/:token", () => {
  it("returns 400 for an invalid token", async () => {
    const app = await buildTestApp();

    const res = await app.inject({ method: "GET", url: "/api/v1/track/click/not-a-real-token" });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_token", message: "invalid_token", statusCode: 400 });

    await app.close();
  });

  it("redirects to the original URL for a well-formed token", async () => {
    const app = await buildTestApp();
    const config = loadEnv();
    const token = buildClickUrl(
      config,
      "00000000-0000-0000-0000-000000000000",
      "step-1",
      "https://example.com/pricing"
    ).split("/click/")[1]!;

    const res = await app.inject({ method: "GET", url: `/api/v1/track/click/${token}` });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("https://example.com/pricing");

    await app.close();
  });

  it("does not require auth headers (public route)", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/track/click/not-a-real-token" });
    expect(res.statusCode).not.toBe(401);
    await app.close();
  });
});
