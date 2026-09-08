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
});
