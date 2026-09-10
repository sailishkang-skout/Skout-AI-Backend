import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import type { FastifyInstance } from "fastify";

const WORKSPACE = "00000000-0000-4000-8000-000000000001";

const BASE_OVERRIDES = {
  CLERK_SECRET_KEY: undefined as unknown as string,
  LOG_LEVEL: "fatal" as const,
};

let app: FastifyInstance;

beforeAll(async () => {
  const config = loadEnv();
  app = await buildApp({ ...config, ...BASE_OVERRIDES });
});

afterAll(async () => {
  await app?.close();
});

describe("GET /api/v1/dashboard/funnel", () => {
  it("returns non-negative real counts for the caller's workspace", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/funnel",
      headers: { "x-workspace-id": WORKSPACE },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: { discovered: number; enriched: number; inSequence: number; replied: number; activeInSequence: number };
    };
    expect(body.data.discovered).toBeGreaterThanOrEqual(0);
    expect(body.data.enriched).toBeGreaterThanOrEqual(0);
    expect(body.data.inSequence).toBeGreaterThanOrEqual(0);
    expect(body.data.replied).toBeGreaterThanOrEqual(0);
    expect(body.data.activeInSequence).toBeGreaterThanOrEqual(0);
  });
});
