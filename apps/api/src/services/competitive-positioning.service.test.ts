import { describe, expect, it } from "vitest";
import { buildCompetitivePositioningPolicy } from "./competitive-positioning.service.js";

describe("buildCompetitivePositioningPolicy", () => {
  it("returns proposed_not_proven when gate is not validated", () => {
    const policy = buildCompetitivePositioningPolicy("not_validated", 2);
    expect(policy.status).toBe("proposed_not_proven");
    expect(policy.regionalTamLearning).toBe("no_go");
    expect(policy.differentiators).toHaveLength(3);
    expect(policy.marketingPolicy).toMatch(/proposed hypotheses/i);
  });

  it("returns validated when gate clears", () => {
    const policy = buildCompetitivePositioningPolicy("validated", 4);
    expect(policy.status).toBe("validated");
    expect(policy.regionalTamLearning).toBe("go");
  });
});
