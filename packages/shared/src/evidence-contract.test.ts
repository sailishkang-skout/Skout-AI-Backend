import { describe, expect, it } from "vitest";
import { UNKNOWN, UnevidencedClaimError, assertEvidenced, reportOrUnknown } from "./evidence-contract.js";

describe("reportOrUnknown", () => {
  it("returns the value when sample size clears the minimum", () => {
    expect(reportOrUnknown(0.42, 50, 20)).toBe(0.42);
  });

  it("returns UNKNOWN when sample size is below the minimum", () => {
    expect(reportOrUnknown(0.42, 5, 20)).toBe(UNKNOWN);
  });

  it("returns UNKNOWN for a non-finite sample size rather than throwing", () => {
    expect(reportOrUnknown(0.42, NaN, 20)).toBe(UNKNOWN);
  });

  it("treats a sample size exactly at the minimum as sufficient", () => {
    expect(reportOrUnknown("ok", 20, 20)).toBe("ok");
  });
});

describe("assertEvidenced", () => {
  it("passes through a claim with an evidenceId", () => {
    const claim = { value: 42, evidenceId: "abc-123" };
    expect(assertEvidenced(claim, "test claim")).toBe(claim);
  });

  it("passes through a claim explicitly marked unverified", () => {
    const claim = { value: 42, unverified: true as const };
    expect(assertEvidenced(claim, "test claim")).toBe(claim);
  });

  it("throws for a claim with neither an evidenceId nor unverified flag", () => {
    expect(() => assertEvidenced({ value: 42 }, "ICP fit score")).toThrow(UnevidencedClaimError);
    expect(() => assertEvidenced({ value: 42 }, "ICP fit score")).toThrow(/ICP fit score/);
  });
});
