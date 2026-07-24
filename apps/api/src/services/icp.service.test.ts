import { describe, expect, it } from "vitest";
import { mergeIcpConfig } from "./icp.service.js";

describe("mergeIcpConfig", () => {
  it("preserves existing onboarding when the incoming payload omits it", () => {
    const existing = {
      industries: ["SaaS"],
      onboarding: { completedAt: "2026-01-01T00:00:00.000Z", goals: ["Pipeline"] },
    };
    const incoming = { industries: ["SaaS", "Software"], countries: ["US"] };

    expect(mergeIcpConfig(existing, incoming)).toEqual({
      industries: ["SaaS", "Software"],
      countries: ["US"],
      onboarding: { completedAt: "2026-01-01T00:00:00.000Z", goals: ["Pipeline"] },
    });
  });

  it("keeps completedAt when a partial onboarding update omits it", () => {
    const existing = {
      onboarding: { completedAt: "2026-01-01T00:00:00.000Z", crm: "HubSpot" },
    };
    const incoming = {
      onboarding: { crm: "Salesforce", goals: ["Outbound"] },
    };

    expect(mergeIcpConfig(existing, incoming).onboarding).toEqual({
      completedAt: "2026-01-01T00:00:00.000Z",
      crm: "Salesforce",
      goals: ["Outbound"],
    });
  });

  it("allows wizard finish to set completedAt", () => {
    const existing = { onboarding: { goals: ["Pipeline"] } };
    const incoming = {
      industries: ["SaaS"],
      onboarding: { completedAt: "2026-07-24T00:00:00.000Z", goals: ["Pipeline"] },
    };

    expect(mergeIcpConfig(existing, incoming).onboarding?.completedAt).toBe(
      "2026-07-24T00:00:00.000Z"
    );
  });
});
