import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { loadEnv } from "../config/env.js";
import { securityPlugin } from "./security.js";

describe("security plugin auth rate limit", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const config = { ...loadEnv(), RATE_LIMIT_MAX: 200, RATE_LIMIT_WINDOW_MS: 60_000 };
    app = Fastify();
    app.decorate("config", config);
    await app.register(securityPlugin, config);
    app.post("/api/v1/auth/login", async () => ({ ok: true }));
    app.get("/api/v1/health", async () => ({ ok: true }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("caps /api/v1/auth/* at 30 and returns AUTH_RATE_LIMITED", async () => {
    let lastStatus = 200;
    for (let i = 0; i < 31; i++) {
      const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: {} });
      lastStatus = res.statusCode;
      if (i < 30) expect(res.statusCode).toBe(200);
      else {
        expect(res.statusCode).toBe(429);
        expect(res.json().code).toBe("AUTH_RATE_LIMITED");
      }
    }
    expect(lastStatus).toBe(429);
  });

  it("does not count auth traffic against the health allow-list", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
  });
});
