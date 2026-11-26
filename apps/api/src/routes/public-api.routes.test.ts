import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { isPublicApiPath } from "./public-api.routes.js";

describe("public API edge surface (PAPI-001)", () => {
  let app: FastifyInstance;
  let origin: string;
  beforeAll(async () => {
    const config = loadEnv();
    origin = config.CORS_ORIGIN[0]!;
    app = await buildApp({ ...config, LOG_LEVEL: "fatal", CLERK_SECRET_KEY: undefined });
  });
  afterAll(async () => {
    await app.close();
  });

  it("answers /api/public/v1/health without a key", async () => {
    const res = await app.inject({ method: "GET", url: "/api/public/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", service: "skout-public-api", version: "v1" });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["strict-transport-security"]).toContain("max-age=");
  });

  it("sends no CORS headers, even to an allowed origin", async () => {
    const res = await app.inject({ method: "GET", url: "/api/public/v1/health", headers: { origin } });
    expect(Object.keys(res.headers).filter((h) => h.startsWith("access-control-"))).toEqual([]);
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/api/public/v1/health",
      headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization" },
    });
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("never sets cookies and ignores the ones it gets", async () => {
    const res = await app.inject({ method: "GET", url: "/api/public/v1/health", headers: { cookie: "__session=abc; skout_rt=xyz" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("keeps CORS for the internal API", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/health", headers: { origin } });
    expect(res.headers["access-control-allow-origin"]).toBe(origin);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("ignores a client-supplied X-Request-Id on the public API (it keys credit holds)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/public/v1/health", headers: { "x-request-id": "attacker-chosen" } });
    expect(res.headers["x-request-id"]).toMatch(/^req_[0-9a-f]{32}$/);
    const internal = await app.inject({ method: "GET", url: "/api/v1/health", headers: { "x-request-id": "trace-123" } });
    expect(internal.headers["x-request-id"]).toBe("trace-123");
  });

  it("matches only the public prefix", () => {
    expect(isPublicApiPath("/api/public/v1/people/search")).toBe(true);
    expect(isPublicApiPath("/api/public")).toBe(true);
    expect(isPublicApiPath("/api/publicity")).toBe(false);
    expect(isPublicApiPath("/api/v1/public/x")).toBe(false);
  });
});
