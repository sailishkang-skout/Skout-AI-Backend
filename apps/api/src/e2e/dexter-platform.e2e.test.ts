import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";

/**
 * §10.4 / §10.5 / D7 / D14 / D15 HTTP E2E — Policy Gateway, Dexter plans,
 * LinkedIn voice confirm, decision views, workflow runs, regional TAM gate.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)("§10 Dexter / Policy / LinkedIn voice HTTP E2E", () => {
  let app: FastifyInstance;
  const email = `dexter-e2e-${Date.now()}@test.com`;

  beforeAll(async () => {
    const config = loadEnv();
    app = await buildApp({
      ...config,
      CLERK_SECRET_KEY: undefined,
      LOG_LEVEL: "error",
      AUTH_STUB: true,
      OPENROUTER_API_KEY: undefined,
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  function headers() {
    return {
      "x-stub-user-email": email,
      "content-type": "application/json",
    };
  }

  it("§10.4 — propose → approve → invoke → learn Dexter plan via Policy Gateway", async () => {
    const proposed = await app.inject({
      method: "POST",
      url: "/api/v1/dexter/plans",
      headers: headers(),
      payload: { brief: "Enroll high-fit SaaS VPs in Mode C cadence" },
    });
    expect(proposed.statusCode).toBe(201);
    const planId = (proposed.json() as { data: { plan: { id: string }; policy: { mode: string } } }).data.plan.id;
    expect(planId).toBeTruthy();

    const classified = await app.inject({
      method: "POST",
      url: "/api/v1/policy/classify",
      headers: headers(),
      payload: { actionKey: "dexter.plan_invoke" },
    });
    expect(classified.statusCode).toBe(200);
    expect((classified.json() as { data: { mode: string } }).data.mode).toBeTruthy();

    const approved = await app.inject({
      method: "POST",
      url: `/api/v1/dexter/plans/${planId}/approve`,
      headers: headers(),
    });
    expect(approved.statusCode).toBe(200);

    const invoked = await app.inject({
      method: "POST",
      url: `/api/v1/dexter/plans/${planId}/invoke`,
      headers: headers(),
    });
    expect(invoked.statusCode).toBe(200);
    expect((invoked.json() as { data: { plan: { status: string } } }).data.plan.status).toBe("invoked");

    const learned = await app.inject({
      method: "POST",
      url: `/api/v1/dexter/plans/${planId}/learn`,
      headers: headers(),
      payload: { learning: { thresholdDelta: 0, attribution: "hypothesis_hold" } },
    });
    expect(learned.statusCode).toBe(200);
    expect((learned.json() as { data: { status: string } }).data.status).toBe("learned");
  });

  it("§10.5 — LinkedIn voice handoff + manual confirm (no background send)", async () => {
    const handoff = await app.inject({
      method: "POST",
      url: "/api/v1/linkedin/voice/handoff",
      headers: headers(),
      payload: {
        prospectId: "e2e-li-voice-prospect",
        scriptText: "Hi — short regional-aware voice note.",
        voiceChoice: "self",
        regionalBriefPreview: "US West Coast SaaS tone",
      },
    });
    expect(handoff.statusCode).toBe(201);
    const token = (handoff.json() as { data: { handoffToken: string } }).data.handoffToken;

    const confirmed = await app.inject({
      method: "POST",
      url: "/api/v1/linkedin/voice/confirm-sent",
      headers: headers(),
      payload: { handoffToken: token },
    });
    expect(confirmed.statusCode).toBe(200);
    expect((confirmed.json() as { data: { status: string } }).data.status).toBe("confirmed");
  });

  it("D14/D15 — decision view + observable workflow run", async () => {
    const run = await app.inject({
      method: "POST",
      url: "/api/v1/workflows/runs",
      headers: headers(),
      payload: {
        name: "e2e-enrich-pipeline",
        steps: [{ name: "enqueue" }, { name: "score" }],
        correlationId: `corr-${Date.now()}`,
      },
    });
    expect(run.statusCode).toBe(201);
    const runId = (run.json() as { data: { id: string } }).data.id;

    const done = await app.inject({
      method: "POST",
      url: `/api/v1/workflows/runs/${runId}/complete`,
      headers: headers(),
      payload: { status: "completed" },
    });
    expect(done.statusCode).toBe(200);

    const decision = await app.inject({
      method: "POST",
      url: "/api/v1/decisions/from-nba",
      headers: headers(),
      payload: {
        entityType: "contact",
        entityId: "00000000-0000-4000-8000-000000000099",
      },
    });
    expect(decision.statusCode).toBe(201);
  });

  it("§3 — seed demo win/loss clears regional TAM gate; competitive purpose requires it", async () => {
    const before = await app.inject({
      method: "POST",
      url: "/api/v1/regional-intel",
      headers: headers(),
      payload: { location: "San Francisco", purpose: "competitive" },
    });
    // Without ≥4 deals → 422 for competitive
    expect([422, 502]).toContain(before.statusCode);

    const seed = await app.inject({
      method: "POST",
      url: "/api/v1/competitive/win-loss/seed-demo",
      headers: headers(),
    });
    expect(seed.statusCode).toBe(201);
    expect((seed.json() as { data: { gate: string } }).data.gate).toBe("validated");

    const onboarding = await app.inject({
      method: "POST",
      url: "/api/v1/regional-intel",
      headers: headers(),
      payload: { location: "San Francisco", purpose: "onboarding" },
    });
    // onboarding allowed even before; after seed still ok (502 if no OpenRouter)
    expect([200, 502]).toContain(onboarding.statusCode);

    const gate = await app.inject({
      method: "GET",
      url: "/api/v1/regional-tam-gate",
      headers: headers(),
    });
    expect(gate.statusCode).toBe(200);
    expect((gate.json() as { data: { gate: string; dealsReviewed: number } }).data.dealsReviewed).toBeGreaterThanOrEqual(4);
  });

  it("§11.1 — automation policy upsert + decisions list (SSO contract: stub auth → workspace provision)", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/v1/automation-policy",
      headers: headers(),
      payload: { actionKey: "dexter.enroll_list", mode: "approve" },
    });
    expect(put.statusCode).toBe(200);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/automation-policy",
      headers: headers(),
    });
    expect(list.statusCode).toBe(200);
    const policies = (list.json() as { data: { policies: Array<{ actionKey: string }> } }).data.policies;
    expect(policies.some((p) => p.actionKey === "dexter.enroll_list")).toBe(true);

    const decisions = await app.inject({
      method: "GET",
      url: "/api/v1/policy/decisions",
      headers: headers(),
    });
    expect(decisions.statusCode).toBe(200);
  });
});
