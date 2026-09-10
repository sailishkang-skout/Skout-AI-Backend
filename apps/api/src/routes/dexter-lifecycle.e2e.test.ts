import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import type { FastifyInstance } from "fastify";

/** §10.4 — Dexter approval-to-learning lifecycle HTTP e2e. */
const WORKSPACE = "00000000-0000-4000-8000-000000000001";

const BASE_OVERRIDES = {
  CLERK_SECRET_KEY: undefined as unknown as string,
  LOG_LEVEL: "fatal" as const,
  AI_SERVICE_URL: undefined as unknown as string,
  REDIS_URL: undefined as unknown as string,
};

let app: FastifyInstance;
let planId: string;

beforeAll(async () => {
  app = await buildApp({ ...loadEnv(), ...BASE_OVERRIDES });
}, 60000);

afterAll(async () => {
  await app?.close();
});

describe("§10.4 — Dexter approval-to-learning lifecycle", { timeout: 60000 }, () => {
  it("propose → approve → invoke → learn", async () => {
    const propose = await app.inject({
      method: "POST",
      url: "/api/v1/dexter/plans",
      headers: { "x-workspace-id": WORKSPACE, "content-type": "application/json" },
      payload: { brief: "E2E test plan for high-fit SaaS VPs" },
    });
    expect(propose.statusCode).toBe(201);
    planId = (propose.json() as { data: { plan: { id: string } } }).data.plan.id;
    expect(planId).toBeTruthy();

    const approve = await app.inject({
      method: "POST",
      url: `/api/v1/dexter/plans/${planId}/approve`,
      headers: { "x-workspace-id": WORKSPACE },
    });
    expect(approve.statusCode).toBe(200);

    const invoke = await app.inject({
      method: "POST",
      url: `/api/v1/dexter/plans/${planId}/invoke`,
      headers: { "x-workspace-id": WORKSPACE, "x-user-id": "00000000-0000-4000-8000-000000000099" },
    });
    expect([200, 403]).toContain(invoke.statusCode);

    const learn = await app.inject({
      method: "POST",
      url: `/api/v1/dexter/plans/${planId}/learn`,
      headers: { "x-workspace-id": WORKSPACE, "content-type": "application/json" },
      payload: { learning: { attribution: "e2e", thresholdDelta: 0 } },
    });
    expect([200, 400, 403]).toContain(learn.statusCode);
  });

  it("command center exposes plan history", async () => {
    const center = await app.inject({
      method: "GET",
      url: "/api/v1/dexter/command-center",
      headers: { "x-workspace-id": WORKSPACE },
    });
    expect(center.statusCode).toBe(200);
    const body = center.json() as { data: { plans: unknown[] } };
    expect(Array.isArray(body.data.plans)).toBe(true);
  });
});
