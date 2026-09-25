import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@skout/db";
import { loadEnv, type Env } from "../config/env.js";

vi.mock("../services/login-discovery.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/login-discovery.service.js")>();
  return { ...actual, fetchCohortRows: vi.fn(async () => []) };
});

import { fetchCohortRows } from "../services/login-discovery.service.js";
import { authDiscoveryRoutes, DISCOVERY_MIN_RESPONSE_MS } from "./auth-discovery.routes.js";

const fetchCohortRowsMock = vi.mocked(fetchCohortRows);

async function buildApp(overrides: Partial<Env> = {}, opts: { withRateLimit?: boolean } = {}) {
  const config: Env = { ...loadEnv(), AUTH_CUSTOM_ENABLED: true, ...overrides };
  const app = Fastify({ logger: { level: "fatal" } });
  app.decorate("config", config);
  // The lookup is mocked, so the route only needs a truthy db handle.
  app.decorate("db", {} as Db);
  if (opts.withRateLimit) {
    await app.register(rateLimit, { global: true, max: 1000, timeWindow: 60_000 });
  }
  await app.register(authDiscoveryRoutes, { prefix: "/api/v1" });
  await app.ready();
  return app;
}

function discover(app: FastifyInstance, email: unknown) {
  return app.inject({ method: "POST", url: "/api/v1/auth/discover", payload: { email } });
}

describe("POST /auth/discover (AUTH-BE-22)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    fetchCohortRowsMock.mockReset();
    fetchCohortRowsMock.mockResolvedValue([]);
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("404s when AUTH_CUSTOM_ENABLED is off", async () => {
    const offApp = await buildApp({ AUTH_CUSTOM_ENABLED: false });
    const res = await discover(offApp, "a@example.com");
    expect(res.statusCode).toBe(404);
    expect(fetchCohortRowsMock).not.toHaveBeenCalled();
    await offApp.close();
  });

  it("returns the environment default when no cohort row matches", async () => {
    const res = await discover(app, "someone@example.com");
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ method: "clerk" });

    const pwApp = await buildApp({ AUTH_DISCOVERY_DEFAULT_METHOD: "password" });
    expect((await discover(pwApp, "someone@example.com")).json().data).toEqual({ method: "password" });
    await pwApp.close();
  });

  it("looks up the normalized email and its domain", async () => {
    await discover(app, "  Bob@Example.COM ");
    expect(fetchCohortRowsMock).toHaveBeenCalledWith(expect.anything(), "bob@example.com", "example.com");
  });

  it("returns sso for an SSO-bound domain", async () => {
    fetchCohortRowsMock.mockResolvedValue([{ subjectType: "domain", method: "sso" }]);
    expect((await discover(app, "user@corp.example")).json().data).toEqual({ method: "sso" });
  });

  it("an exact-email override beats the domain", async () => {
    fetchCohortRowsMock.mockResolvedValue([
      { subjectType: "domain", method: "password" },
      { subjectType: "email", method: "microsoft" },
    ]);
    expect((await discover(app, "vip@corp.example")).json().data).toEqual({ method: "microsoft" });
  });

  it("known and unknown emails get byte-identical responses and both wait the minimum time", async () => {
    // The route never consults users/credentials, so "known" vs "unknown" only differs in what a
    // real database holds for that address — with no cohort row, both resolve the same way.
    const timings: number[] = [];
    const bodies: string[] = [];
    for (const email of ["existing-user@example.com", "no-such-user@example.com"]) {
      const started = Date.now();
      const res = await discover(app, email);
      timings.push(Date.now() - started);
      bodies.push(res.body);
      expect(res.statusCode).toBe(200);
    }
    expect(bodies[0]).toBe(bodies[1]);
    for (const t of timings) expect(t).toBeGreaterThanOrEqual(DISCOVERY_MIN_RESPONSE_MS - 5);
  });

  it("rejects a missing or malformed email with 400 without querying", async () => {
    expect((await discover(app, undefined)).statusCode).toBe(400);
    expect((await discover(app, "not-an-email")).statusCode).toBe(400);
    expect(fetchCohortRowsMock).not.toHaveBeenCalled();
  });

  it("is rate-limited harder than login: the 6th request in a minute gets 429", async () => {
    const limited = await buildApp({}, { withRateLimit: true });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await discover(limited, `user${i}@example.com`)).statusCode);
    }
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
    await limited.close();
  });
});
