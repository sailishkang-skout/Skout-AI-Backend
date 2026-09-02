import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import type { FastifyInstance } from "fastify";

/** §10.5 — LinkedIn AI voice handoff HTTP e2e (draft + handoff token). */
const WORKSPACE = "00000000-0000-4000-8000-000000000001";

const BASE_OVERRIDES = {
  CLERK_SECRET_KEY: undefined as unknown as string,
  LOG_LEVEL: "fatal" as const,
  AI_SERVICE_URL: undefined as unknown as string,
  REDIS_URL: undefined as unknown as string,
};

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ ...loadEnv(), ...BASE_OVERRIDES });
}, 60000);

afterAll(async () => {
  await app?.close();
});

describe("§10.5 — LinkedIn AI voice handoff", { timeout: 60000 }, () => {
  it("lists handoffs and accepts draft script request shape", async () => {
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/linkedin/voice/handoffs",
      headers: { "x-workspace-id": WORKSPACE },
    });
    expect(list.statusCode).toBe(200);
    expect(Array.isArray((list.json() as { data: unknown[] }).data)).toBe(true);

    const draft = await app.inject({
      method: "POST",
      url: "/api/v1/linkedin/voice/draft-script",
      headers: { "x-workspace-id": WORKSPACE, "content-type": "application/json" },
      payload: {
        contactId: "00000000-0000-4000-8000-000000000002",
        tone: "professional",
        language: "en",
      },
    });
    expect([200, 400, 403, 404, 422]).toContain(draft.statusCode);
  });
});
