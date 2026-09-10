import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import type { FastifyInstance } from "fastify";

/**
 * SS-09 — end-to-end proof that finishing onboarding with an autonomy-mode choice actually
 * writes enforceable Policy Gateway rows, not just a value inside workspace_icp.config.
 */
const BASE_OVERRIDES = {
  CLERK_SECRET_KEY: undefined as unknown as string,
  LOG_LEVEL: "fatal" as const,
};

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ ...loadEnv(), ...BASE_OVERRIDES });
});

afterAll(async () => {
  await app?.close();
});

function completeOnboardingPayload(autonomyMode: "manual" | "assisted" | "autonomous") {
  return {
    onboarding: {
      company: { name: "Acme Co", industry: "SaaS", size: "11-50" },
      goals: ["Generate leads"],
      icp: { industries: ["Software"] },
      people: { seniorities: ["vp"] },
      market: ["North America"],
      leadVolume: "medium",
      autonomyMode,
      completedAt: new Date().toISOString(),
    },
  };
}

describe("§8.1/SS-09 — onboarding autonomy mode reaches the Policy Gateway", () => {
  it("completing onboarding with autonomyMode=autonomous sets every action key to auto", async () => {
    const stubEmail = `ss09-autonomous-${Date.now()}@test.com`;

    const put = await app.inject({
      method: "PUT",
      url: "/api/v1/workspace/icp",
      headers: { "x-stub-user-email": stubEmail, "content-type": "application/json" },
      payload: completeOnboardingPayload("autonomous"),
    });
    expect(put.statusCode).toBe(200);

    const policies = await app.inject({
      method: "GET",
      url: "/api/v1/automation-policy",
      headers: { "x-stub-user-email": stubEmail },
    });
    expect(policies.statusCode).toBe(200);
    const body = policies.json() as { data: { policies: { actionKey: string; mode: string }[] } };
    const modeByKey = Object.fromEntries(body.data.policies.map((p) => [p.actionKey, p.mode]));
    expect(modeByKey["dexter.plan_invoke"]).toBe("auto");
    expect(modeByKey["sequence.enroll"]).toBe("auto");
    expect(modeByKey["linkedin.voice_confirm"]).toBe("auto");
  });

  it("completing onboarding with autonomyMode=manual only overrides the one default-auto action key", async () => {
    const stubEmail = `ss09-manual-${Date.now()}@test.com`;

    const put = await app.inject({
      method: "PUT",
      url: "/api/v1/workspace/icp",
      headers: { "x-stub-user-email": stubEmail, "content-type": "application/json" },
      payload: completeOnboardingPayload("manual"),
    });
    expect(put.statusCode).toBe(200);

    const policies = await app.inject({
      method: "GET",
      url: "/api/v1/automation-policy",
      headers: { "x-stub-user-email": stubEmail },
    });
    const body = policies.json() as {
      data: { policies: { actionKey: string; mode: string }[]; defaults: { actionKey: string; mode: string }[] };
    };
    const overridden = Object.fromEntries(body.data.policies.map((p) => [p.actionKey, p.mode]));
    expect(overridden["sequence.enroll"]).toBe("ask");
    // dexter.plan_invoke's default (approve) is left as a default, not re-written as an override.
    expect(overridden["dexter.plan_invoke"]).toBeUndefined();
    const defaultModeByKey = Object.fromEntries(body.data.defaults.map((d) => [d.actionKey, d.mode]));
    expect(defaultModeByKey["dexter.plan_invoke"]).toBe("approve");
  });

  it("an incremental wizard-step save without completedAt does not touch automation_policies", async () => {
    const stubEmail = `ss09-incremental-${Date.now()}@test.com`;

    const put = await app.inject({
      method: "PUT",
      url: "/api/v1/workspace/icp",
      headers: { "x-stub-user-email": stubEmail, "content-type": "application/json" },
      payload: { onboarding: { autonomyMode: "autonomous" } }, // no completedAt — mid-wizard save
    });
    expect(put.statusCode).toBe(200);

    const policies = await app.inject({
      method: "GET",
      url: "/api/v1/automation-policy",
      headers: { "x-stub-user-email": stubEmail },
    });
    const body = policies.json() as { data: { policies: unknown[] } };
    expect(body.data.policies).toHaveLength(0);
  });

  // EDGE CASE 1: autonomyMode switching updates policies correctly
  it("switching autonomyMode from manual to autonomous updates all policies to auto", async () => {
    const stubEmail = `ss09-switch-${Date.now()}@test.com`;

    // First submit manual mode
    const put1 = await app.inject({
      method: "PUT",
      url: "/api/v1/workspace/icp",
      headers: { "x-stub-user-email": stubEmail, "content-type": "application/json" },
      payload: completeOnboardingPayload("manual"),
    });
    expect(put1.statusCode).toBe(200);

    // Then switch to autonomous mode
    const put2 = await app.inject({
      method: "PUT",
      url: "/api/v1/workspace/icp",
      headers: { "x-stub-user-email": stubEmail, "content-type": "application/json" },
      payload: completeOnboardingPayload("autonomous"),
    });
    expect(put2.statusCode).toBe(200);

    const policies = await app.inject({
      method: "GET",
      url: "/api/v1/automation-policy",
      headers: { "x-stub-user-email": stubEmail },
    });
    expect(policies.statusCode).toBe(200);
    const body = policies.json() as { data: { policies: { actionKey: string; mode: string }[] } };
    const modeByKey = Object.fromEntries(body.data.policies.map((p) => [p.actionKey, p.mode]));
    // All policies should be auto after switching
    Object.values(modeByKey).forEach(mode => expect(mode).toBe("auto"));
  });

  // EDGE CASE 2: invalid autonomyMode value is rejected with 400
  it("rejects onboarding submission with invalid autonomyMode value", async () => {
    const stubEmail = `ss09-invalid-${Date.now()}@test.com`;

    const put = await app.inject({
      method: "PUT",
      url: "/api/v1/workspace/icp",
      headers: { "x-stub-user-email": stubEmail, "content-type": "application/json" },
      payload: {
        onboarding: {
          ...completeOnboardingPayload("autonomous").onboarding,
          autonomyMode: "invalid_mode" as never,
        },
      },
    });
    expect(put.statusCode).toBe(400); // validation fails
  });

  // EDGE CASE 3: re-completing onboarding updates existing policies (not duplicates)
  it("re-completing onboarding updates existing policies instead of creating duplicates", async () => {
    const stubEmail = `ss09-update-${Date.now()}@test.com`;

    // First submission: autonomous mode
    const firstPut = await app.inject({
      method: "PUT",
      url: "/api/v1/workspace/icp",
      headers: { "x-stub-user-email": stubEmail, "content-type": "application/json" },
      payload: completeOnboardingPayload("autonomous"),
    });
    expect(firstPut.statusCode).toBe(200);

    // Second submission: switch to manual mode
    const secondPut = await app.inject({
      method: "PUT",
      url: "/api/v1/workspace/icp",
      headers: { "x-stub-user-email": stubEmail, "content-type": "application/json" },
      payload: completeOnboardingPayload("manual"),
    });
    expect(secondPut.statusCode).toBe(200);

    // Verify no duplicate policies, only the new manual mode policies exist
    const policies = await app.inject({
      method: "GET",
      url: "/api/v1/automation-policy",
      headers: { "x-stub-user-email": stubEmail },
    });
    const body = policies.json() as { data: { policies: { actionKey: string; mode: string }[] } };
    const modeByKey = Object.fromEntries(body.data.policies.map((p) => [p.actionKey, p.mode]));
    // Should only have manual mode overrides, no duplicate autonomous policies
    expect(modeByKey["sequence.enroll"]).toBe("ask");
    // Verify no duplicates - only unique action keys
    const actionKeys = body.data.policies.map(p => p.actionKey);
    const uniqueKeys = new Set(actionKeys);
    expect(actionKeys.length).toBe(uniqueKeys.size);
  });

  // EDGE CASE 4: completedAt in invalid date format is rejected
  it("rejects onboarding submission with invalid completedAt date format", async () => {
    const stubEmail = `ss09-bad-date-${Date.now()}@test.com`;

    const put = await app.inject({
      method: "PUT",
      url: "/api/v1/workspace/icp",
      headers: { "x-stub-user-email": stubEmail, "content-type": "application/json" },
      payload: {
        onboarding: {
          ...completeOnboardingPayload("autonomous").onboarding,
          completedAt: "not-a-real-date",
        },
      },
    });
    expect(put.statusCode).toBe(400);
  });
});