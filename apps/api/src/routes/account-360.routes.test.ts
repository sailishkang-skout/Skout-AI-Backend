import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import type { FastifyInstance } from "fastify";

const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const FAKE_UUID = "00000000-0000-4000-8000-000000000099";

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

describe("§8.4 — Account 360 & Person 360 Routes", () => {
  it("GET /api/v1/account-360/:companyId — returns 404 for missing company", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/account-360/${FAKE_UUID}`,
      headers: { "x-workspace-id": WORKSPACE },
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET /api/v1/person-360/:contactId — returns 404 for missing contact", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/person-360/${FAKE_UUID}`,
      headers: { "x-workspace-id": WORKSPACE },
    });
    expect(res.statusCode).toBe(404);
  });
});
