import { describe, expect, it } from "vitest";
import { passesAutoApproveThreshold } from "./draft-auto-approve.service.js";

describe("passesAutoApproveThreshold", () => {
  const settings = { enabled: true, minIcpScore: 80, minConfidence: 0.9 };

  it("passes when both score and confidence clear the bar", () => {
    expect(passesAutoApproveThreshold(settings, { icpScore: 85, confidenceScore: 0.95 })).toBe(true);
  });

  it("fails when disabled, regardless of score/confidence", () => {
    expect(
      passesAutoApproveThreshold({ ...settings, enabled: false }, { icpScore: 100, confidenceScore: 1 })
    ).toBe(false);
  });

  it("fails when icpScore is below the threshold", () => {
    expect(passesAutoApproveThreshold(settings, { icpScore: 79, confidenceScore: 0.95 })).toBe(false);
  });

  it("fails when icpScore is missing but a threshold is set", () => {
    expect(passesAutoApproveThreshold(settings, { icpScore: null, confidenceScore: 0.95 })).toBe(false);
  });

  it("fails when confidenceScore is below the threshold", () => {
    expect(passesAutoApproveThreshold(settings, { icpScore: 85, confidenceScore: 0.5 })).toBe(false);
  });

  it("ignores an unset threshold (null minIcpScore/minConfidence)", () => {
    expect(
      passesAutoApproveThreshold(
        { enabled: true, minIcpScore: null, minConfidence: null },
        { icpScore: null, confidenceScore: null }
      )
    ).toBe(true);
  });
});
